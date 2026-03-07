---
phase: 2
plan: 3
title: "Tool Registry, GitHub Helper, Thin tools.ts Wrapper"
status: done
completed: "2026-03-07"
---

# Plan 3 Summary: Tool Registry, GitHub Helper, Thin tools.ts Wrapper

## What was done

### Task 1: Shared GitHub helper (`src/utils/github.ts`)
- Created `ensureGitHubRepo()` — checks if repo exists, creates if missing, returns URLs
- Created `gitPushToRepo()` — git init + add + commit + force push to remote
- Refactored `deploy.ts`, `build-website.ts`, and `github.ts` to use shared helper
- Eliminated ~60 lines of duplicated repo-check-create-push code across 3 handlers

### Task 2: Auto-discovery registry (`src/tools/registry.ts`)
- `loadTools()` reads `src/tools/handlers/` directory, dynamically imports all `.js` files
- Exports each handler's `ToolHandler` (or array of handlers) into a Map
- `getToolDefinitions()` returns Claude API tool definitions
- `executeTool()` handles Zod validation, local-only proxy, context building
- `proxyToLocal()` moved here from tools.ts

### Task 3: Workflow actions (`src/tools/workflow-actions.ts`)
- Extracted `executeWorkflowActions()` from tools.ts to its own module
- Imports `executeTool` from registry (no circular dependency)

### Task 4: Thin tools.ts wrapper
- `src/agent/tools.ts` reduced from 171 lines to 7 lines (re-exports only)
- `agent.ts` updated: `toolDefinitions` (const) → `getToolDefinitions()` (function call)
- All existing import sites (`server.ts`, `router.ts`, `index.ts`) continue working through re-exports

### Task 5: Startup wiring
- `loadTools()` called in `src/index.ts` after `setupGitAuth()`, before `startServer()`

### Task 6: Server imports verified
- `server.ts` imports `executeTool` and `collectMedia` through `../agent/tools.js` — works via re-export

### Task 7: CLAUDE.md updated
- "Adding Tools" section now documents the single-file workflow

## Verification

- `npx tsc --noEmit` — zero errors
- `wc -l src/agent/tools.ts` — 7 lines (target: <50)
- `grep -c 'switch\|case ' src/agent/tools.ts` — 0 (no switch statement)
- All 3 GitHub-using handlers import `ensureGitHubRepo` from shared helper
- `src/utils/github.ts` exists with both exported functions

## Files changed

| File | Action |
|------|--------|
| `src/utils/github.ts` | **Created** — shared ensureGitHubRepo + gitPushToRepo |
| `src/tools/registry.ts` | **Created** — auto-discovery registry with loadTools() |
| `src/tools/workflow-actions.ts` | **Created** — executeWorkflowActions extracted |
| `src/agent/tools.ts` | **Rewritten** — 7-line re-export wrapper |
| `src/agent/agent.ts` | **Updated** — toolDefinitions → getToolDefinitions() |
| `src/index.ts` | **Updated** — added loadTools() call at startup |
| `src/tools/handlers/deploy.ts` | **Refactored** — uses shared GitHub helper |
| `src/tools/handlers/build-website.ts` | **Refactored** — uses shared GitHub helper |
| `src/tools/handlers/github.ts` | **Refactored** — uses shared GitHub helper |
| `CLAUDE.md` | **Updated** — new "Adding Tools" instructions |

## Key outcome

Adding a new tool now requires creating **one file** in `src/tools/handlers/` — no other files need editing. The registry auto-discovers it at startup.
