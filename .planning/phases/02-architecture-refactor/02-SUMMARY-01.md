---
phase: 2
plan: 1
title: "Infrastructure: Types, Media, Security, HTML Extraction"
status: done
commit: 2e1a133
---

# Summary: Plan 1 — Infrastructure

## What was done

All 6 tasks completed with zero behavior change.

### Task 1: ToolHandler types
- Created `src/tools/types.ts` with `ToolHandler` and `ToolContext` interfaces
- Uses `Database.Database` from better-sqlite3 for the db type

### Task 2: Media side-channel extraction
- Moved `pendingMediaMap`, `setCurrentRequestId`, `addPendingMedia`, `collectMedia` to `src/tools/media.ts`
- `tools.ts` re-exports `setCurrentRequestId` and `collectMedia` for backward compatibility

### Task 3: Security functions extraction
- Moved `isPathAllowed`, `isUrlAllowed`, `isEmailAllowed`, `LOCAL_ONLY_TOOLS` plus all constants to `src/utils/security.ts`
- `tools.ts` imports from the new module; all 9 call sites verified

### Task 4: HTML strip utility
- Created `src/utils/html.ts` with `stripHtml()` function
- Replaced duplicate regex chains in 3 locations:
  - `tools.ts` browse_url case
  - `tools.ts` scrape_site case
  - `knowledge.ts` ingestUrl function
- Verified: `grep -r 'replace(/<script' src/` returns only `src/utils/html.ts`

### Task 5: Static HTML views
- Extracted `getDashboardHTML()` (177 lines) to `src/views/dashboard.html`
- Extracted `getChatHTML()` (112 lines) to `src/views/chat.html`
- `server.ts` now reads files at startup via `readFileSync` + `import.meta.dirname`
- Deleted both inline HTML functions from server.ts

### Task 6: Postbuild copy
- Added `"postbuild": "cp -r src/views dist/views"` to package.json scripts

## Metrics

| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/agent/tools.ts` | ~1270 | 1203 | -67 lines |
| `src/gateway/server.ts` | ~604 | 315 | -289 lines |

## Verification

- `npx tsc --noEmit` passes with zero errors
- Phase 1 security files (`shell-blocklist.ts`, `sanitize.ts`, `git-auth.ts`) untouched
- All Zod schemas and `gitEnv` usage preserved in tools.ts
- `stripHtml` regex only in `src/utils/html.ts` (no duplication)
