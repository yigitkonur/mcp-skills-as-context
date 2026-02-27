#!/usr/bin/env node
/**
 * Stdio MCP transport — this is what runs when you do `npx mcp-skills-as-context`.
 * Implements the same two tools as index.ts but using the raw MCP SDK with stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_API_URL = "https://skills.sh/api/search";
const GITHUB_API_URL = "https://api.github.com";

const SKILLS_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  Cookie: "region=us",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/145.0.0.0 Mobile Safari/537.36",
};

// ---------------------------------------------------------------------------
// GitHub token round-robin
// ---------------------------------------------------------------------------

const githubTokens = (() => {
  const raw = process.env.GITHUB_TOKENS ?? "";
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length > 0) return tokens;
  const single = (process.env.GITHUB_TOKEN ?? "").trim();
  return single ? [single] : [];
})();

let tokenIndex = 0;

function getGitHubHeaders() {
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (githubTokens.length > 0) {
    const token = githubTokens[tokenIndex % githubTokens.length];
    tokenIndex++;
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function findSkillFolder(source, skillId) {
  const url = `${GITHUB_API_URL}/repos/${source}/git/trees/HEAD?recursive=1`;
  const resp = await fetch(url, { headers: getGitHubHeaders() });

  if (resp.status === 403) {
    const body = await resp.json().catch(() => ({}));
    return { folderPath: null, error: body.message ?? "GitHub rate limit exceeded" };
  }
  if (!resp.ok) {
    return { folderPath: null, error: `GitHub Trees API returned ${resp.status}` };
  }

  const data = await resp.json();
  const tree = data.tree ?? [];

  // 1. EXACT MATCH: folder name matches skillId exactly
  const exactCandidates = tree
    .filter((e) => e.type === "tree" && (e.path === skillId || e.path.endsWith(`/${skillId}`)))
    .map((e) => e.path);

  if (exactCandidates.length > 0) {
    return { folderPath: exactCandidates.reduce((a, b) => (a.length <= b.length ? a : b)), error: null };
  }

  // 2. FIND ALL SKILL.md FILES and extract parent folder paths
  const skillMdEntries = tree.filter((e) => e.type === "blob" && /SKILL\.md$/i.test(e.path));

  // 5. NO SKILL.md FOUND AT ALL
  if (skillMdEntries.length === 0) {
    return { folderPath: null, error: "No SKILL.md files found in repository" };
  }

  // Extract parent folders ("" means root-level SKILL.md)
  const skillFolders = skillMdEntries.map((e) => {
    const lastSlash = e.path.lastIndexOf("/");
    return lastSlash === -1 ? "" : e.path.substring(0, lastSlash);
  });

  // 3. SINGLE SKILL.md SHORTCUT (~90% of repos have only one skill)
  if (skillFolders.length === 1) {
    return { folderPath: skillFolders[0], error: null };
  }

  // 4. MULTIPLE SKILL.md — FUZZY MATCH by token overlap + substring bonus
  const skillIdTokens = new Set(skillId.split("-").filter(Boolean));

  const candidates = skillFolders.map((folderPath) => {
    const folderName = folderPath.split("/").pop() || "";
    const folderTokens = new Set(folderName.split("-").filter(Boolean));

    const commonTokens = new Set([...folderTokens].filter((t) => skillIdTokens.has(t)));
    let score = commonTokens.size / Math.max(folderTokens.size, skillIdTokens.size);

    if (skillId.includes(folderName) || folderName.includes(skillId)) {
      score = Math.min(score + 0.5, 1.0);
    }

    return { folderPath, folderName, score };
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (best.score >= 0.30) {
    return { folderPath: best.folderPath, error: null };
  }

  return {
    folderPath: null,
    error: `No matching skill folder found (best match: ${best.folderName} at ${Math.round(best.score * 100)}%)`,
  };
}

async function fetchFolderContents(source, path) {
  const url = `${GITHUB_API_URL}/repos/${source}/contents/${path}`;
  const resp = await fetch(url, { headers: getGitHubHeaders() });

  if (resp.status === 403) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.message ?? "GitHub rate limit exceeded");
  }
  if (!resp.ok) return null;

  const items = await resp.json();
  return Array.isArray(items) ? items : null;
}

async function fetchFileContent(downloadUrl) {
  try {
    const resp = await fetch(downloadUrl);
    if (resp.ok) return await resp.text();
  } catch {
    // skip
  }
  return null;
}

async function collectFiles(source, items) {
  const files = [];
  const fileEntries = items.filter((f) => f.type === "file");
  const dirEntries = items.filter((f) => f.type === "dir");

  const fileResults = await Promise.all(
    fileEntries.map(async (entry) => {
      if (!entry.download_url) return null;
      const content = await fetchFileContent(entry.download_url);
      if (content === null) return null;
      return { path: entry.path ?? "", name: entry.name ?? "", content };
    })
  );
  files.push(...fileResults.filter((f) => f !== null));

  for (const dir of dirEntries) {
    if (!dir.path) continue;
    const subItems = await fetchFolderContents(source, dir.path);
    if (subItems) {
      const subFiles = await collectFiles(source, subItems);
      files.push(...subFiles);
    }
  }
  return files;
}

async function fetchSkillDetails(skillId) {
  const parts = skillId.split("/");
  if (parts.length < 3) {
    return { id: skillId, files: [], error: `Invalid skill ID format. Expected "owner/repo/skillId", got "${skillId}"` };
  }
  const source = `${parts[0]}/${parts[1]}`;
  const skillName = parts.slice(2).join("/");

  const { folderPath, error: findError } = await findSkillFolder(source, skillName);
  if (findError || folderPath === null || folderPath === undefined) {
    return { id: skillId, files: [], error: findError ?? "Skill folder not found" };
  }

  const folderItems = await fetchFolderContents(source, folderPath);
  if (!folderItems) {
    return { id: skillId, files: [], error: "Could not fetch folder contents from GitHub" };
  }

  try {
    const files = await collectFiles(source, folderItems);
    return { id: skillId, files, error: null };
  } catch (err) {
    return { id: skillId, files: [], error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ---------------------------------------------------------------------------
// MCP Server (stdio transport)
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-skills-as-context",
  version: "1.0.4",
});

server.tool(
  "search-skills",
  "Search skills.sh for Claude/AI skill files by keyword. Skills are structured markdown files that describe exactly how to accomplish a task — perfect for feeding context into coding agents and sub-agent briefs. Returns skill names, IDs, sources, and install counts. Use the returned IDs with get-skill-details to fetch the full skill file contents.",
  {
    query: z.string().describe("Search keyword to find skills"),
    limit: z.number().min(1).max(500).optional().describe("Maximum number of results to return (1-500, default 100)"),
  },
  async ({ query, limit }) => {
    const effectiveLimit = limit ?? 100;
    try {
      const url = `${SKILLS_API_URL}?${new URLSearchParams({ q: query, limit: String(effectiveLimit) })}`;
      const resp = await fetch(url, { headers: SKILLS_HEADERS });

      if (!resp.ok) {
        const body = await resp.text();
        return { content: [{ type: "text", text: `Error: skills.sh API returned ${resp.status}: ${body.slice(0, 500)}` }], isError: true };
      }

      const data = await resp.json();
      const skillList = Array.isArray(data) ? data : (data.skills ?? []);
      const skills = skillList.map((s) => ({
        id: `${s.source}/${s.skillId}`,
        name: s.name ?? s.skillId ?? "",
        source: s.source ?? "",
        installs: s.installs ?? 0,
      }));

      return { content: [{ type: "text", text: JSON.stringify({ query, total: skills.length, skills }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
    }
  }
);

server.tool(
  "get-skill-details",
  "Fetch full file contents (SKILL.md + all reference files, scripts, and examples) for multiple skills from their GitHub repos. Pass as many relevant skill IDs as possible from search results — the more context you gather, the better your output will be. Each skill contains structured instructions, templates, and reference materials that dramatically improve agent briefs and task execution. Pro tip: after reviewing the results, consider deepening your research by searching for related skills to build even richer context.",
  {
    skill_ids: z
      .array(z.string().describe('Skill ID in "owner/repo/skillId" format from search results'))
      .min(1)
      .max(10)
      .describe("Array of skill IDs from search results (the 'id' field). Format: owner/repo/skillId"),
  },
  async ({ skill_ids }) => {
    try {
      const results = await Promise.all(skill_ids.map((id) => fetchSkillDetails(id)));
      return { content: [{ type: "text", text: JSON.stringify({ skills: results }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
