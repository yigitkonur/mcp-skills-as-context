import { MCPServer, object, error } from "mcp-use/server";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_API_URL = "https://skills.sh/api/search";
const GITHUB_API_URL = "https://api.github.com";

const SKILLS_HEADERS: Record<string, string> = {
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

const githubTokens: string[] = (() => {
  const raw = process.env.GITHUB_TOKENS ?? "";
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length > 0) return tokens;
  const single = (process.env.GITHUB_TOKEN ?? "").trim();
  return single ? [single] : [];
})();

let tokenIndex = 0;

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (githubTokens.length > 0) {
    const token = githubTokens[tokenIndex % githubTokens.length];
    tokenIndex++;
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new MCPServer({
  name: "skills-mcp-server",
  title: "Skills Search MCP Server",
  version: "1.0.0",
  description: "Search and retrieve Claude/AI skills from skills.sh",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com",
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

server.app.get("/health", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Tool 1: search-skills
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "search-skills",
    description:
      "Search skills.sh for Claude/AI skill files by keyword. Skills are structured markdown files that describe exactly how to accomplish a task — perfect for feeding context into coding agents and sub-agent briefs. Returns skill names, IDs, sources, and install counts. Use the returned IDs with get-skill-details to fetch the full skill file contents.",
    schema: z.object({
      query: z.string().describe("Search keyword to find skills"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of results to return (1-500, default 100)"),
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, limit }) => {
    const effectiveLimit = limit ?? 100;
    try {
      const url = `${SKILLS_API_URL}?${new URLSearchParams({
        q: query,
        limit: String(effectiveLimit),
      })}`;
      const resp = await fetch(url, { headers: SKILLS_HEADERS });

      if (!resp.ok) {
        const body = await resp.text();
        return error(
          `skills.sh API returned ${resp.status}: ${body.slice(0, 500)}`
        );
      }

      const data: any = await resp.json();
      const skillList: any[] = Array.isArray(data)
        ? data
        : (data.skills ?? []);

      const skills = skillList.map((s: any) => ({
        id: `${s.source}/${s.skillId}`,
        name: s.name ?? s.skillId ?? "",
        source: s.source ?? "",
        installs: s.installs ?? 0,
      }));

      return object({ query, total: skills.length, skills });
    } catch (err) {
      console.error("search-skills error:", err);
      return error(
        `Failed to search skills: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: get-skill-details — helpers
// ---------------------------------------------------------------------------

/** Use the Git Trees API to locate a skill folder at any depth in the repo. */
async function findSkillFolder(
  source: string,
  skillId: string
): Promise<{ folderPath: string | null; error: string | null }> {
  const url = `${GITHUB_API_URL}/repos/${source}/git/trees/HEAD?recursive=1`;
  const resp = await fetch(url, { headers: getGitHubHeaders() });

  if (resp.status === 403) {
    const body: any = await resp.json().catch(() => ({}));
    return {
      folderPath: null,
      error: body.message ?? "GitHub rate limit exceeded",
    };
  }
  if (!resp.ok) {
    return {
      folderPath: null,
      error: `GitHub Trees API returned ${resp.status}`,
    };
  }

  const data: any = await resp.json();
  const tree: any[] = data.tree ?? [];

  // Match entries where the last path component equals skillId
  const candidates = tree
    .filter(
      (entry: any) =>
        entry.type === "tree" &&
        (entry.path === skillId || entry.path.endsWith(`/${skillId}`))
    )
    .map((entry: any) => entry.path as string);

  if (candidates.length === 0) {
    return { folderPath: null, error: "Skill folder not found in repository" };
  }

  // Prefer shortest path (most direct match)
  const folderPath = candidates.reduce((a, b) =>
    a.length <= b.length ? a : b
  );
  return { folderPath, error: null };
}

/** Fetch the contents of a GitHub directory via the Contents API. */
async function fetchFolderContents(
  source: string,
  path: string
): Promise<any[] | null> {
  const url = `${GITHUB_API_URL}/repos/${source}/contents/${path}`;
  const resp = await fetch(url, { headers: getGitHubHeaders() });

  if (resp.status === 403) {
    const body: any = await resp.json().catch(() => ({}));
    throw new Error(body.message ?? "GitHub rate limit exceeded");
  }
  if (!resp.ok) return null;

  const items = await resp.json();
  return Array.isArray(items) ? items : null;
}

/** Download raw file content from a GitHub download URL. */
async function fetchFileContent(downloadUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(downloadUrl);
    if (resp.ok) return await resp.text();
  } catch {
    // Silently skip unreachable files
  }
  return null;
}

/** Recursively collect all files from a GitHub folder listing. */
async function collectFiles(
  source: string,
  items: any[]
): Promise<Array<{ path: string; name: string; content: string }>> {
  const files: Array<{ path: string; name: string; content: string }> = [];

  const fileEntries = items.filter((f: any) => f.type === "file");
  const dirEntries = items.filter((f: any) => f.type === "dir");

  // Fetch all file contents in parallel
  const fileResults = await Promise.all(
    fileEntries.map(async (entry: any) => {
      if (!entry.download_url) return null;
      const content = await fetchFileContent(entry.download_url);
      if (content === null) return null;
      return { path: entry.path ?? "", name: entry.name ?? "", content };
    })
  );
  files.push(
    ...fileResults.filter((f): f is NonNullable<typeof f> => f !== null)
  );

  // Recurse into subdirectories
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

/** Fetch all file contents for a single skill from its GitHub repo. */
async function fetchSkillDetails(
  skillId: string
): Promise<{
  id: string;
  files: Array<{ path: string; name: string; content: string }>;
  error: string | null;
}> {
  // Parse "owner/repo/skillName" — first two segments are the GitHub source
  const parts = skillId.split("/");
  if (parts.length < 3) {
    return {
      id: skillId,
      files: [],
      error: `Invalid skill ID format. Expected "owner/repo/skillId", got "${skillId}"`,
    };
  }
  const source = `${parts[0]}/${parts[1]}`;
  const skillName = parts.slice(2).join("/");

  const { folderPath, error: findError } = await findSkillFolder(
    source,
    skillName
  );
  if (findError || !folderPath) {
    return {
      id: skillId,
      files: [],
      error: findError ?? "Skill folder not found",
    };
  }

  const folderItems = await fetchFolderContents(source, folderPath);
  if (!folderItems) {
    return {
      id: skillId,
      files: [],
      error: "Could not fetch folder contents from GitHub",
    };
  }

  try {
    const files = await collectFiles(source, folderItems);
    return { id: skillId, files, error: null };
  } catch (err) {
    return {
      id: skillId,
      files: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Tool 2: get-skill-details
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "get-skill-details",
    description:
      "Fetch full file contents (SKILL.md + all reference files, scripts, and examples) for multiple skills from their GitHub repos. Pass as many relevant skill IDs as possible from search results — the more context you gather, the better your output will be. Each skill contains structured instructions, templates, and reference materials that dramatically improve agent briefs and task execution. Pro tip: after reviewing the results, consider deepening your research by searching for related skills to build even richer context.",
    schema: z.object({
      skill_ids: z
        .array(
          z
            .string()
            .describe('Skill ID in format "owner/repo/skillId" from search results')
        )
        .min(1)
        .max(10)
        .describe(
          "Array of skill IDs from search results (the 'id' field). Format: owner/repo/skillId"
        ),
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ skill_ids }, ctx) => {
    try {
      const total = skill_ids.length;
      let completed = 0;
      await ctx.reportProgress?.(0, total, "Fetching skill details...");

      // Process all skills in parallel
      const results = await Promise.all(
        skill_ids.map(async (id) => {
          const result = await fetchSkillDetails(id);
          completed++;
          await ctx.reportProgress?.(
            completed,
            total,
            `Fetched ${completed}/${total} skills`
          );
          return result;
        })
      );

      return object({ skills: results });
    } catch (err) {
      console.error("get-skill-details error:", err);
      return error(
        `Failed to fetch skill details: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`Server running on port ${PORT}`);
server.listen(PORT);
