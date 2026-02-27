# mcp-skills-as-context

> Turn [skills.sh](https://skills.sh) into a context goldmine for your coding agents.

An MCP server that searches skills.sh and fetches complete skill files from GitHub — giving your AI agents the exact instructions they need to nail any task.

## Why This Exists

Skill files are structured instructions that show *exactly* how a task should be done. They're incredibly valuable context for coding agents — but there are thousands of them on skills.sh, across hundreds of GitHub repos.

You need a programmatic way to search and fetch them. This MCP server does exactly that.

**The loop:**

1. Search skills.sh for what you're building
2. Fetch the full skill files (SKILL.md + all references) from GitHub
3. Feed that context to your coding agent
4. Get insanely good briefs, implementations, and outputs

If you're a prompt engineer or building coding agents, this is for you.

## The Power Loop

Say you're building a Playwright testing agent. Or a React app where skills are split across dashboards and marketing sites. Instead of hand-writing every instruction:

```
You: "search for playwright testing skills"
  → search-skills finds 15 matching skills
  → get-skill-details fetches their SKILL.md files + all referenced files
  → Feed that context into your sub-agent brief
  → Agent generates a perfectly structured implementation
```

Grab all the context. Feed it to your agent. Watch it produce work that actually follows best practices.

## Tools

### `search-skills`

Search skills.sh by keyword. Returns skill names, IDs, sources, and install counts.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Search keyword to find skills |
| `limit` | `number` | Max results, 1–500 (default 100) |

Returns an array of skills, each with an `id` you'll pass to `get-skill-details`.

### `get-skill-details`

Fetch the full file contents for up to 10 skills at once from their GitHub repos. Pass the `id` values from search results.

| Parameter | Type | Description |
|-----------|------|-------------|
| `skill_ids` | `string[]` | Skill IDs in `owner/repo/skillId` format (1–10) |

Returns every file in each skill's folder — SKILL.md, reference configs, templates, the lot. **Pass many IDs at once** for richer context.

## Installation

The fastest way to install is with [`install-mcp`](https://github.com/nichochar/install-mcp):

### Claude Desktop

```bash
npx install-mcp mcp-skills-as-context --client claude-desktop
```

### Cursor

```bash
npx install-mcp mcp-skills-as-context --client cursor
```

### VS Code

```bash
npx install-mcp mcp-skills-as-context --client vscode
```

### Claude Code

```bash
npx install-mcp mcp-skills-as-context --client claude-code
```

### Other Clients

```bash
# Windsurf
npx install-mcp mcp-skills-as-context --client windsurf

# Cline / Roo-Cline
npx install-mcp mcp-skills-as-context --client cline
npx install-mcp mcp-skills-as-context --client roo-cline

# Zed
npx install-mcp mcp-skills-as-context --client zed

# Codex (OpenAI)
npx install-mcp mcp-skills-as-context --client codex

# Goose
npx install-mcp mcp-skills-as-context --client goose

# Warp
npx install-mcp mcp-skills-as-context --client warp

# Gemini CLI
npx install-mcp mcp-skills-as-context --client gemini-cli

# Aider
npx install-mcp mcp-skills-as-context --client aider
```

### Manual Setup

Add to your client's MCP config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "skills-as-context": {
      "command": "npx",
      "args": ["mcp-skills-as-context"],
      "env": {
        "GITHUB_TOKENS": "your-github-pat-1,your-github-pat-2"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKENS` | Comma-separated GitHub PATs for higher rate limits (recommended) |
| `GITHUB_TOKEN` | Single GitHub PAT (fallback) |

GitHub tokens are optional but recommended — without them you'll hit rate limits quickly when fetching skill files.

## Development

```bash
git clone https://github.com/yigitkonur/mcp-skills-as-context.git
cd mcp-skills-as-context
npm install
npm run dev
# Inspector at http://localhost:3000/inspector
```

## How It Works

1. **Search** — Queries the skills.sh API (`/api/search`) and returns matching skills with metadata
2. **Resolve** — Parses the skill ID (`owner/repo/skillId`) to locate the GitHub repository
3. **Discover** — Uses the GitHub Git Trees API to find the skill folder at any depth in the repo tree
4. **Fetch** — Recursively downloads every file in the skill folder (SKILL.md, configs, templates, sub-directories)
5. **Return** — Delivers the complete file contents so your agent has full context

All GitHub requests use token round-robin across multiple PATs to maximize throughput.

## License

MIT
