---
phase: 2
plan: 2
title: "Extract All Tool Handlers to Individual Files"
status: done
completed: "2026-03-07"
---

# Plan 2 Summary: Extract All Tool Handlers to Individual Files

## What Was Done

Extracted all 37 tool handler cases from the `executeTool()` switch statement in `src/agent/tools.ts` into 27 individual handler files under `src/tools/handlers/`. Each handler implements the `ToolHandler` interface from Plan 1.

## Files Created (27 handler files)

### DB-only tools
- `src/tools/handlers/reminders.ts` — set_reminder, list_reminders, delete_reminder (3 tools)
- `src/tools/handlers/tasks.ts` — add_task, list_tasks, complete_task (3 tools)
- `src/tools/handlers/api-costs.ts` — api_costs (1 tool)
- `src/tools/handlers/schedule-message.ts` — schedule_message (1 tool)
- `src/tools/handlers/remember.ts` — remember (1 tool)

### Pass-through tools
- `src/tools/handlers/knowledge.ts` — learn_url, learn_text, search_knowledge, list_knowledge, delete_knowledge (5 tools)
- `src/tools/handlers/workflows.ts` — create_workflow, list_workflows, delete_workflow, toggle_workflow (4 tools)
- `src/tools/handlers/calendar.ts` — calendar_list, calendar_add (2 tools)
- `src/tools/handlers/monday.ts` — monday_api (1 tool)

### Web/content tools
- `src/tools/handlers/web-search.ts` — web_search (1 tool)
- `src/tools/handlers/web-research.ts` — web_research (1 tool)
- `src/tools/handlers/browse-url.ts` — browse_url (1 tool)
- `src/tools/handlers/scrape-site.ts` — scrape_site (1 tool)
- `src/tools/handlers/analyze-image.ts` — analyze_image (1 tool)

### Media/file tools
- `src/tools/handlers/generate-image.ts` — generate_image (1 tool)
- `src/tools/handlers/send-voice.ts` — send_voice (1 tool)
- `src/tools/handlers/send-email.ts` — send_email (1 tool)
- `src/tools/handlers/shell.ts` — shell (1 tool)
- `src/tools/handlers/files.ts` — read_file, write_file, send_file (3 tools)
- `src/tools/handlers/screenshot.ts` — screenshot (1 tool)

### Complex tools
- `src/tools/handlers/github.ts` — create_github_repo (1 tool)
- `src/tools/handlers/deploy.ts` — deploy_app (1 tool)
- `src/tools/handlers/build-website.ts` — build_website (1 tool)
- `src/tools/handlers/auto-improve.ts` — auto_improve (1 tool)
- `src/tools/handlers/code-agent.ts` — code_agent (1 tool)
- `src/tools/handlers/cron-script.ts` — cron_script (1 tool)
- `src/tools/handlers/manage-project.ts` — manage_project (1 tool)

### Files Modified
- `src/agent/tools.ts` — replaced 1100-line switch statement with Map-based handler lookup (~160 lines)

## Security Preservation Verified

| Security Check | Handler Files |
|---|---|
| `isShellCommandSafe` | shell.ts |
| `redactSecrets` | shell.ts, github.ts, deploy.ts, build-website.ts, auto-improve.ts |
| `isPathAllowed` | files.ts (read_file, write_file, send_file) |
| `isUrlAllowed` | browse-url.ts, scrape-site.ts, analyze-image.ts, knowledge.ts |
| `isEmailAllowed` | send-email.ts |
| `sanitizeWebContent` | browse-url.ts, scrape-site.ts |
| `gitEnv()` | github.ts, deploy.ts, build-website.ts, auto-improve.ts |
| `localOnly: true` | screenshot.ts, manage-project.ts, files.ts (send_file) |

## Zod Schemas Moved

All 10 Zod schemas moved from tools.ts to their handler files:
shellSchema, writeFileSchema, sendEmailSchema, deployAppSchema, autoImproveSchema, setReminderSchema, browseUrlSchema, mondayApiSchema, codeAgentSchema, cronScriptSchema

## Verification

- `npx tsc --noEmit` passes with zero errors
- 27 handler files in src/tools/handlers/
- tools.ts has no `case` statements in executeTool (only in executeWorkflowActions which delegates to executeTool)
- tools.ts has no Zod schema declarations
- Total tools: 37 (matching original count)
