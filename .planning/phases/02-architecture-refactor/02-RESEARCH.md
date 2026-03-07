# Phase 2 Research: Architecture Refactor

**Date:** 2026-03-07
**Scope:** ARCH-01 through ARCH-06
**Source files analyzed:** `src/agent/tools.ts` (1,283 lines), `src/gateway/server.ts` (603 lines), `src/agent/knowledge.ts`

---

## 1. Tool Registry Pattern Design

### 1.1 ToolHandler Interface

Every tool must implement this interface. It captures definition (for Claude API) and execution in one unit:

```typescript
// src/tools/types.ts

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

export interface ToolContext {
  config: typeof import('../utils/config.js').config;
  db: typeof import('../utils/db.js').db;
  addPendingMedia: (item: { type: 'image' | 'voice'; data: Buffer }) => void;
}

export interface ToolHandler {
  /** Tool name — must match the name in `definition` */
  name: string;

  /** Claude API tool definition (name, description, input_schema) */
  definition: Anthropic.Tool;

  /** Optional Zod schema for input validation (validated before execute) */
  schema?: z.ZodType<any>;

  /** If true, tool is proxied to local Mac in cloud mode */
  localOnly?: boolean;

  /** Execute the tool and return a string result */
  execute(input: Record<string, any>, ctx: ToolContext): Promise<string>;
}
```

### 1.2 Why This Shape

- **`name`** is redundant with `definition.name` but enables O(1) registry lookup without parsing the definition object.
- **`schema`** is optional because not all tools have Zod validation today (only 10 of 37 do). Tools without schemas still work; validation is progressive.
- **`localOnly`** replaces the `LOCAL_ONLY_TOOLS` array. Each tool declares its own constraint.
- **`ToolContext`** is a dependency injection bag. It replaces the current pattern of module-level imports of `config`, `db`, and the `addPendingMedia` function. This makes tools unit-testable by passing mock context.

### 1.3 Registry Implementation

```typescript
// src/tools/registry.ts

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolHandler, ToolContext } from './types.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { z } from 'zod';

const handlers = new Map<string, ToolHandler>();

/** Auto-discover and register all tool handlers from src/tools/handlers/ */
export async function loadTools(): Promise<void> {
  const handlersDir = join(import.meta.dirname, 'handlers');
  const files = readdirSync(handlersDir).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const mod = await import(pathToFileURL(join(handlersDir, file)).href);
    // Each file exports a default ToolHandler or an array of ToolHandler
    const exported = mod.default;
    const tools: ToolHandler[] = Array.isArray(exported) ? exported : [exported];
    for (const tool of tools) {
      if (!tool.name || !tool.definition || !tool.execute) {
        console.warn(`[Registry] Skipping invalid tool in ${file}`);
        continue;
      }
      handlers.set(tool.name, tool);
    }
  }

  console.log(`[Registry] Loaded ${handlers.size} tools from ${files.length} files`);
}

/** Get all tool definitions for the Claude API */
export function getToolDefinitions(): Anthropic.Tool[] {
  return Array.from(handlers.values()).map(h => h.definition);
}

/** Get list of local-only tool names */
export function getLocalOnlyTools(): string[] {
  return Array.from(handlers.values())
    .filter(h => h.localOnly)
    .map(h => h.name);
}

/** Execute a tool by name with validation and proxy logic */
export async function executeTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  const handler = handlers.get(name);
  if (!handler) return `Unknown tool: ${name}`;

  // Validate with Zod if schema exists
  if (handler.schema) {
    const result = handler.schema.safeParse(input);
    if (!result.success) {
      const errors = result.error.issues
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Validation error: ${errors}`;
    }
    input = result.data;
  }

  return handler.execute(input, ctx);
}
```

### 1.4 Auto-Discovery Mechanism

**At build time:** TypeScript compiles `src/tools/handlers/*.ts` to `dist/tools/handlers/*.js`.

**At startup:** `loadTools()` reads the `handlers/` directory, dynamically imports each `.js` file, and registers them. No manual import list needed.

**Adding a new tool:** Create one file in `src/tools/handlers/`, export a `ToolHandler` -- done. No other files need editing. This satisfies ARCH-02 success criterion.

**Important:** `import.meta.dirname` is available in Node.js 21+ (which the project uses on Node 22). For the compiled output, the `dist/tools/handlers/` directory must exist. The build step handles this automatically since tsc preserves directory structure.

---

## 2. Current tools.ts Analysis: Complete Tool Map

### 2.1 All 37 Tool Cases in the Switch Statement

Below is every `case` in `executeTool()`, with its line range, dependencies, and complexity:

| # | Tool Name | Lines | Dependencies | Shared State | Complexity |
|---|-----------|-------|-------------|-------------|-----------|
| 1 | `shell` | 318-329 | `execSync`, `isShellCommandSafe`, `redactSecrets` | none | Low |
| 2 | `read_file` | 331-340 | `readFileSync`, `isPathAllowed` | none | Low |
| 3 | `write_file` | 342-352 | `writeFileSync`, `isPathAllowed` | none | Low |
| 4 | `web_search` | 354-376 | `fetch` | none | Medium |
| 5 | `web_research` | 378-413 | `fetch`, `config.geminiApiKey` | none | Medium |
| 6 | `browse_url` | 415-436 | `fetch`, `isUrlAllowed`, `sanitizeWebContent`, HTML strip | none | Low |
| 7 | `analyze_image` | 438-478 | `fetch`, `config.geminiApiKey`, `isUrlAllowed` | none | Medium |
| 8 | `generate_image` | 480-511 | `fetch`, `config.geminiApiKey` | `addPendingMedia` | Medium |
| 9 | `set_reminder` | 513-520 | `addCronJob`, `config` | none | Low |
| 10 | `list_reminders` | 522-526 | `db` | none | Low |
| 11 | `delete_reminder` | 528-531 | `db` | none | Low |
| 12 | `remember` | 533-542 | `saveMemory` | none | Low |
| 13 | `monday_api` | 544-560 | `fetch`, `config.mondayApiKey` | none | Low |
| 14 | `send_voice` | 562-590 | `fetch`, `config.elevenlabsApiKey` | `addPendingMedia` | Medium |
| 15 | `send_email` | 592-613 | `createTransport`, `isEmailAllowed`, `config` | none | Low |
| 16 | `screenshot` | 615-626 | `execSync`, `readFileSync`, `unlinkSync` | `addPendingMedia` | Low |
| 17 | `api_costs` | 628-647 | `db` | none | Low |
| 18 | `add_task` | 649-653 | `db` | none | Low |
| 19 | `list_tasks` | 655-659 | `db` | none | Low |
| 20 | `complete_task` | 661-664 | `db` | none | Low |
| 21 | `send_file` | 666-682 | `readFileSync`, `isPathAllowed` | `addPendingMedia` | Low |
| 22 | `manage_project` | 684-703 | `execSync` | none | Low |
| 23 | `schedule_message` | 705-716 | `db`, `config` | none | Low |
| 24 | `learn_url` | 719-728 | `ingestUrl`, `isUrlAllowed`, `config` | none | Low |
| 25 | `learn_text` | 730-738 | `ingestText`, `config` | none | Low |
| 26 | `search_knowledge` | 740-749 | `searchKnowledge`, `config` | none | Low |
| 27 | `list_knowledge` | 751-755 | `listDocs` | none | Low |
| 28 | `delete_knowledge` | 757-760 | `deleteDoc` | none | Low |
| 29 | `create_workflow` | 763-769 | `addWorkflow` | none | Low |
| 30 | `list_workflows` | 772-780 | `listWorkflows` | none | Low |
| 31 | `delete_workflow` | 782-785 | `deleteWorkflow` | none | Low |
| 32 | `toggle_workflow` | 787-790 | `toggleWorkflow` | none | Low |
| 33 | `calendar_list` | 793-809 | `fetch`, `config.googleCalendarScriptUrl` | none | Low |
| 34 | `calendar_add` | 811-833 | `fetch`, `config` | none | Low |
| 35 | `create_github_repo` | 836-876 | `fetch`, `execSync`, `gitEnv`, `redactSecrets` | none | Medium |
| 36 | `deploy_app` | 879-936 | `fetch`, `execSync`, `gitEnv`, `redactSecrets` | none | High (dup) |
| 37 | `build_website` | 1028-1068 | `fetch`, `execSync`, `writeFileSync`, `gitEnv`, `redactSecrets` | none | High (dup) |
| 38 | `cron_script` | 939-950 | `addCronJob`, `config` | none | Low |
| 39 | `auto_improve` | 953-1025 | `execSync`, `readFileSync`, `writeFileSync`, `gitEnv`, `redactSecrets`, `config` | none | High |
| 40 | `scrape_site` | 1071-1126 | `fetch`, `isUrlAllowed`, `sanitizeWebContent`, HTML strip | none | Medium |
| 41 | `code_agent` | 1129-1237 | `spawn`, `execSync`, `existsSync`, `mkdirSync`, `config` | none | High |

(Note: some tools share numbers because the actual count is ~37 unique tool names with the `auto_improve` containing 3 sub-actions.)

### 2.2 Shared Dependencies Summary

These are the cross-cutting concerns that tool handlers need access to:

| Dependency | Used By | How to Provide |
|-----------|---------|----------------|
| `config` | ~20 tools | Via `ToolContext` |
| `db` | 8 tools (reminders, tasks, costs, schedule) | Via `ToolContext` |
| `addPendingMedia` | 5 tools (generate_image, send_voice, screenshot, send_file, generate_image) | Via `ToolContext` |
| `isPathAllowed` | 4 tools (read_file, write_file, send_file) | Import from `src/utils/security.ts` (new) |
| `isUrlAllowed` | 5 tools (browse_url, analyze_image, learn_url, scrape_site) | Import from `src/utils/security.ts` (new) |
| `isEmailAllowed` | 1 tool (send_email) | Import from `src/utils/security.ts` (new) |
| `isShellCommandSafe` | 1 tool (shell) | Import from `src/utils/shell-blocklist.ts` (existing) |
| `sanitizeWebContent` | 2 tools (browse_url, scrape_site) | Import from `src/utils/sanitize.ts` (existing) |
| `gitEnv`, `redactSecrets` | 5 tools (github, deploy, build_website, auto_improve) | Import from `src/utils/git-auth.ts` (existing) |
| `execSync` | 10 tools | Node built-in import |
| `fetch` | 12 tools | Global |
| Knowledge functions | 5 tools | Import from `src/agent/knowledge.ts` |
| Workflow functions | 4 tools | Import from `src/agent/workflows.ts` |
| `saveMemory` | 1 tool | Import from `src/agent/memory.ts` |
| `addCronJob` | 2 tools | Import from `src/cron/scheduler.ts` |

### 2.3 Security Functions to Extract

Currently in `tools.ts` lines 62-108, these three security functions should move to `src/utils/security.ts`:

- `isPathAllowed(filePath: string): boolean` (lines 67-78)
- `isUrlAllowed(url: string): boolean` (lines 81-97)
- `isEmailAllowed(to: string): boolean` (lines 103-108)

Along with their associated constants:
- `ALLOWED_FILE_DIRS` (line 63)
- `BLOCKED_FILE_PATTERNS` (line 65)
- `ALLOWED_EMAIL_DOMAINS` (line 100)
- `ALLOWED_EMAIL_ADDRESSES` (line 101)

---

## 3. HTML Extraction Patterns

### 3.1 Current Inline HTML

`src/gateway/server.ts` has two inline HTML functions:

| Function | Lines | Size | Variables Referenced |
|----------|-------|------|---------------------|
| `getDashboardHTML()` | 310-488 | ~178 lines | None -- all data fetched client-side via `/api/dashboard/*` |
| `getChatHTML()` | 490-603 | ~113 lines | None -- all data fetched client-side via `/api/chat/*` |

**Key finding:** Neither HTML template uses server-side variables. Both are fully self-contained static HTML that fetch data via JavaScript `fetch()` calls to the API endpoints. This means extraction is trivial -- no template engine needed.

### 3.2 Extraction Plan

Create static HTML files and serve them:

```
src/
  views/
    dashboard.html    (extracted from getDashboardHTML)
    chat.html         (extracted from getChatHTML)
```

In `server.ts`, replace the function calls with:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

// Cache at startup (no need to re-read on every request)
const dashboardHTML = readFileSync(join(import.meta.dirname, '../views/dashboard.html'), 'utf-8');
const chatHTML = readFileSync(join(import.meta.dirname, '../views/chat.html'), 'utf-8');

app.get('/dashboard', dashAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHTML);
});

app.get('/chat', dashAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(chatHTML);
});
```

**Why not `express.static`:** The HTML pages are behind `dashAuth` middleware. Using `express.static` would bypass auth. Reading once at startup and serving via the auth middleware is simpler and equally fast.

**Build consideration:** The `views/` directory must be copied to `dist/` during build. Add to `tsconfig.json` or use a `postbuild` script: `cp -r src/views dist/views`.

### 3.3 Alternative: `public/` Directory

If we want to serve them as truly static files, we could:
1. Put them in `public/dashboard.html` and `public/chat.html`
2. Use `express.static('public')` for static assets
3. But redirect `/dashboard` and `/chat` through auth middleware that then reads from the public directory

The `src/views/` approach is cleaner because it keeps the auth flow simple.

---

## 4. Shared Utility Extraction

### 4.1 HTML Stripping (ARCH-05)

**Three locations with identical logic** (4-line regex chain):

1. `src/agent/tools.ts` line 425-431 (`browse_url`)
2. `src/agent/tools.ts` line 1095-1101 (`scrape_site`)
3. `src/agent/knowledge.ts` line 98-103 (`ingestUrl`)

All three do the exact same thing:
```typescript
text = html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
```

The only difference is the `browse_url` version also applies `.slice(0, 8000)` and `sanitizeWebContent()` after stripping, while `scrape_site` uses `.slice(0, 3000)`.

**Extraction target:** `src/utils/html.ts`

```typescript
// src/utils/html.ts

/**
 * Strip HTML tags, scripts, and styles from raw HTML.
 * Returns plain text with collapsed whitespace.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

Callers apply their own `.slice()` and `sanitizeWebContent()` as needed.

### 4.2 Deploy Logic (ARCH-06)

**Two near-identical blocks in `deploy_app`** (lines 886-907 for Vercel, lines 909-928 for Railway):

Both do:
1. Check if GitHub repo exists via API
2. Create repo if 404
3. `git init && git add -A && git commit && git push --force`
4. Return "connect to [platform]" message

**`build_website`** (lines 1028-1068) duplicates the same repo-check-create-push pattern.

**`create_github_repo`** (lines 836-876) has the create-repo-and-push pattern but with slightly different options (supports `private`, `auto_init`).

**Extraction target:** `src/utils/github.ts`

```typescript
// src/utils/github.ts

export async function ensureGitHubRepo(
  repoName: string,
  options?: { description?: string; private?: boolean }
): Promise<{ url: string; cloneUrl: string; created: boolean }> {
  // Check if exists, create if not
}

export function gitPushToRepo(
  localDir: string,
  cloneUrl: string,
  commitMessage: string
): void {
  // git init, add, commit, push
}
```

This would reduce `deploy_app` from ~50 lines to ~15, and `build_website` similarly.

---

## 5. Migration Strategy

### 5.1 Incremental Extraction Order

The refactor must be done incrementally so the bot remains functional at every commit. Here is the dependency-safe order:

#### Wave 1: Infrastructure (no behavior change)

1. **Create `src/tools/types.ts`** -- Define `ToolHandler` and `ToolContext` interfaces.
2. **Create `src/utils/html.ts`** -- Extract `stripHtml()`. Update 3 call sites.
3. **Create `src/utils/security.ts`** -- Move `isPathAllowed`, `isUrlAllowed`, `isEmailAllowed` + constants from `tools.ts`. Update imports in `tools.ts`.
4. **Create `src/views/dashboard.html` and `src/views/chat.html`** -- Extract HTML from `server.ts`. Replace with `readFileSync`. Add copy step to build.

After Wave 1: `tools.ts` drops ~50 lines (security functions + constants) but still has all tool logic. `server.ts` drops ~290 lines. All behavior is identical.

#### Wave 2: Extract Simple Tools (low risk)

Extract the simplest tools first -- those with no shared state and minimal dependencies:

**Batch A -- DB-only tools (5 files):**
- `src/tools/handlers/reminders.ts` -- `set_reminder`, `list_reminders`, `delete_reminder` (group as one file, they share context)
- `src/tools/handlers/tasks.ts` -- `add_task`, `list_tasks`, `complete_task`
- `src/tools/handlers/api-costs.ts` -- `api_costs`
- `src/tools/handlers/schedule-message.ts` -- `schedule_message`
- `src/tools/handlers/remember.ts` -- `remember`

**Batch B -- Pass-through tools (4 files):**
- `src/tools/handlers/knowledge.ts` -- `learn_url`, `learn_text`, `search_knowledge`, `list_knowledge`, `delete_knowledge`
- `src/tools/handlers/workflows.ts` -- `create_workflow`, `list_workflows`, `delete_workflow`, `toggle_workflow`
- `src/tools/handlers/calendar.ts` -- `calendar_list`, `calendar_add`
- `src/tools/handlers/monday.ts` -- `monday_api`

After Wave 2: ~14 tool cases removed from `tools.ts` switch. Each extracted tool is independently testable.

#### Wave 3: Extract Medium-Complexity Tools

**Batch C -- Web/content tools (5 files):**
- `src/tools/handlers/web-search.ts` -- `web_search`
- `src/tools/handlers/web-research.ts` -- `web_research`
- `src/tools/handlers/browse-url.ts` -- `browse_url`
- `src/tools/handlers/scrape-site.ts` -- `scrape_site`
- `src/tools/handlers/analyze-image.ts` -- `analyze_image`

**Batch D -- Media tools (3 files):**
- `src/tools/handlers/generate-image.ts` -- `generate_image`
- `src/tools/handlers/send-voice.ts` -- `send_voice`
- `src/tools/handlers/send-email.ts` -- `send_email`

**Batch E -- File tools (3 files):**
- `src/tools/handlers/shell.ts` -- `shell`
- `src/tools/handlers/files.ts` -- `read_file`, `write_file`, `send_file`
- `src/tools/handlers/screenshot.ts` -- `screenshot`

After Wave 3: Only 5-6 complex tools remain in `tools.ts`.

#### Wave 4: Extract Complex Tools + Registry

**Batch F -- GitHub/deploy tools (3 files) + shared helper:**
- `src/utils/github.ts` -- Shared `ensureGitHubRepo()` + `gitPushToRepo()`
- `src/tools/handlers/github.ts` -- `create_github_repo`
- `src/tools/handlers/deploy.ts` -- `deploy_app` (now uses shared helper)
- `src/tools/handlers/build-website.ts` -- `build_website`

**Batch G -- Self-modification + code agent (2 files):**
- `src/tools/handlers/auto-improve.ts` -- `auto_improve`
- `src/tools/handlers/code-agent.ts` -- `code_agent`
- `src/tools/handlers/cron-script.ts` -- `cron_script`
- `src/tools/handlers/manage-project.ts` -- `manage_project`

**Final:** Create `src/tools/registry.ts` with `loadTools()`, wire it into `src/index.ts` startup, and reduce `src/agent/tools.ts` to a thin re-export wrapper:

```typescript
// src/agent/tools.ts (final form — under 50 lines)
export { executeTool, getToolDefinitions as toolDefinitions } from '../tools/registry.js';
export { setCurrentRequestId, collectMedia } from '../tools/media.js';
export { executeWorkflowActions } from '../tools/workflow-actions.js';
```

### 5.2 Media Side-Channel Migration

The `pendingMediaMap`, `setCurrentRequestId`, `addPendingMedia`, and `collectMedia` functions (lines 43-58) must be extracted to a shared module that the registry and individual tools can import:

```typescript
// src/tools/media.ts
const pendingMediaMap = new Map<string, Array<{ type: 'image' | 'voice'; data: Buffer }>>();
let currentRequestId = 'default';

export function setCurrentRequestId(id: string) { currentRequestId = id; }
export function addPendingMedia(item: { type: 'image' | 'voice'; data: Buffer }) { ... }
export function collectMedia(requestId?: string): Array<{ type: 'image' | 'voice'; data: Buffer }> { ... }
```

This is done in Wave 1 alongside the infrastructure setup, since many tools depend on `addPendingMedia`.

### 5.3 Proxy Logic Migration

The `proxyToLocal()` function and the local-only tool check (lines 272-315) move into the registry's `executeTool()`. Each tool declares `localOnly: true` in its handler definition; the registry checks `config.mode === 'cloud'` and proxies automatically.

### 5.4 Verification Strategy

After each wave:
1. **Build check:** `npm run build` must pass with zero errors.
2. **Smoke test:** Start the bot locally (`npm run dev`), send a test message that triggers at least one tool from the extracted batch.
3. **Regression check:** Verify the tool count in the system prompt matches expected (37 tools).
4. **Import check:** `tools.ts` line count should decrease monotonically.

### 5.5 What NOT to Change in Phase 2

- Do **not** convert `execSync` to async (that is Phase 3, REL-01).
- Do **not** add retry logic (Phase 3, REL-03).
- Do **not** replace `console.log` with pino (Phase 3, REL-04).
- Do **not** add tests (Phase 4, QAL-01/02).
- Do **not** fix empty catch blocks (Phase 3, REL-02).
- Preserve all existing security patterns (blocklists, path checks, SSRF prevention) -- they were hardened in Phase 1.

---

## 6. File Structure After Refactor

```
src/
  tools/
    types.ts              # ToolHandler, ToolContext interfaces
    registry.ts           # loadTools(), executeTool(), getToolDefinitions()
    media.ts              # pendingMediaMap, addPendingMedia, collectMedia
    workflow-actions.ts   # executeWorkflowActions()
    handlers/
      shell.ts            # shell
      files.ts            # read_file, write_file, send_file
      screenshot.ts       # screenshot
      web-search.ts       # web_search
      web-research.ts     # web_research
      browse-url.ts       # browse_url
      scrape-site.ts      # scrape_site
      analyze-image.ts    # analyze_image
      generate-image.ts   # generate_image
      send-voice.ts       # send_voice
      send-email.ts       # send_email
      reminders.ts        # set_reminder, list_reminders, delete_reminder
      tasks.ts            # add_task, list_tasks, complete_task
      remember.ts         # remember
      schedule-message.ts # schedule_message
      api-costs.ts        # api_costs
      monday.ts           # monday_api
      calendar.ts         # calendar_list, calendar_add
      knowledge.ts        # learn_url, learn_text, search_knowledge, list_knowledge, delete_knowledge
      workflows.ts        # create_workflow, list_workflows, delete_workflow, toggle_workflow
      github.ts           # create_github_repo
      deploy.ts           # deploy_app
      build-website.ts    # build_website
      auto-improve.ts     # auto_improve
      code-agent.ts       # code_agent
      cron-script.ts      # cron_script
      manage-project.ts   # manage_project
  utils/
    html.ts               # stripHtml()  [NEW]
    security.ts           # isPathAllowed, isUrlAllowed, isEmailAllowed  [NEW]
    github.ts             # ensureGitHubRepo, gitPushToRepo  [NEW]
    config.ts             # (existing)
    db.ts                 # (existing)
    embeddings.ts         # (existing)
    git-auth.ts           # (existing)
    sanitize.ts           # (existing)
    shell-blocklist.ts    # (existing)
  views/
    dashboard.html        # (extracted from server.ts)
    chat.html             # (extracted from server.ts)
  agent/
    tools.ts              # Thin re-export wrapper (<50 lines)
    ...                   # (rest unchanged)
```

---

## 7. Example Tool Handler File

```typescript
// src/tools/handlers/tasks.ts

import type { ToolHandler } from '../types.js';

const addTask: ToolHandler = {
  name: 'add_task',
  definition: {
    name: 'add_task',
    description: 'Add task to todo list',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        priority: { type: 'number', description: '1-10' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['title'],
    },
  },
  async execute(input, ctx) {
    const stmt = ctx.db.prepare('INSERT INTO tasks (title, priority, due_date) VALUES (?, ?, ?)');
    const result = stmt.run(input.title, input.priority || 5, input.due_date || null);
    return `Task #${result.lastInsertRowid} added: "${input.title}"`;
  },
};

const listTasks: ToolHandler = {
  name: 'list_tasks',
  definition: {
    name: 'list_tasks',
    description: 'List pending tasks',
    input_schema: { type: 'object' as const, properties: {} },
  },
  async execute(_input, ctx) {
    const tasks = ctx.db.prepare(
      "SELECT id, title, priority, due_date, created_at FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at"
    ).all() as any[];
    if (tasks.length === 0) return 'No pending tasks.';
    return tasks.map(t =>
      `#${t.id} [${t.priority}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`
    ).join('\n');
  },
};

const completeTask: ToolHandler = {
  name: 'complete_task',
  definition: {
    name: 'complete_task',
    description: 'Mark task as done',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  async execute(input, ctx) {
    const result = ctx.db.prepare(
      "UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'pending'"
    ).run(input.id);
    return result.changes > 0
      ? `Task #${input.id} completed!`
      : `Task #${input.id} not found or already done.`;
  },
};

export default [addTask, listTasks, completeTask];
```

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Import path breaks after restructure | High | Build fails | Run `npm run build` after every wave |
| Tool not discovered (missing from registry) | Medium | Tool silently unavailable | Log tool count at startup; compare against expected 37 |
| `import.meta.dirname` not available in test/old Node | Low | Registry fails to load | Check Node version; fallback to `fileURLToPath` |
| HTML files not copied to dist/ | Medium | 404 on dashboard/chat | Add `postbuild` copy script |
| Circular dependency between tools and registry | Low | Build error | Tools import from utils, never from registry |
| Breaking the re-export in agent/tools.ts | Medium | agent.ts can't find executeTool | Keep agent/tools.ts as a stable API surface |

---

## 9. Requirement Traceability

| Requirement | Satisfied By | Verification |
|------------|-------------|-------------|
| ARCH-01 | Each handler file in `src/tools/handlers/` with `ToolHandler` interface | Count handler files = tool count |
| ARCH-02 | `loadTools()` in registry.ts reads directory at startup | Add a tool file, restart, verify it appears |
| ARCH-03 | `agent/tools.ts` becomes <50 line re-export | `wc -l src/agent/tools.ts` < 50 |
| ARCH-04 | `src/views/dashboard.html` and `src/views/chat.html` | Edit HTML without touching .ts files |
| ARCH-05 | `src/utils/html.ts` with `stripHtml()` | Only one implementation exists; grep confirms |
| ARCH-06 | `src/utils/github.ts` with `ensureGitHubRepo()` + `gitPushToRepo()` | `deploy_app` and `build_website` call shared helper |

---

*Research completed: 2026-03-07*
