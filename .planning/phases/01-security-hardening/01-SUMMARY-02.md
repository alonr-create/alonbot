# Summary: Plan 2 — Git Token Removal & Output Redaction

## What Was Built

Removed GITHUB_TOKEN from all git remote URLs (5 locations) so tokens never appear in `git remote -v` output or error messages. Added GIT_ASKPASS-based authentication and defense-in-depth output redaction.

## Key Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `src/utils/git-auth.ts` | Created | Three exports: `setupGitAuth()`, `gitEnv()`, `redactSecrets()` |
| `src/index.ts` | Modified | Import + call `setupGitAuth()` before any tool execution |
| `src/agent/tools.ts` | Modified | Import `gitEnv`/`redactSecrets`; remove token from 5 git URLs; add `env: gitEnv()` to 5 execSync calls; wrap 4 error handlers + shell output with `redactSecrets()` |
| `.planning/STATE.md` | Modified | Plan 2 status: Pending -> Done |

## Changes by Task

1. **git-auth utility** — `setupGitAuth()` writes `/tmp/alonbot-git-askpass.sh` (mode 700) at startup; `gitEnv()` returns env with `GIT_ASKPASS` + `GIT_TERMINAL_PROMPT=0`; `redactSecrets()` strips ghp_, gho_, github_pat_, sk-ant-, Bearer tokens, embedded URL credentials, and the literal GITHUB_TOKEN value.
2. **Startup call** — `setupGitAuth()` called in `src/index.ts` before Telegram polling or cron jobs.
3. **deploy_app** — Both vercel and railway sections: removed `${token}@` from pushUrl, added `env: gitEnv()`, wrapped error with `redactSecrets()`.
4. **auto_improve** — Removed `${token}@` from git push URL, added `env: gitEnv()`, wrapped git error with `redactSecrets()`.
5. **build_website** — Removed `${token}@` from pushUrl, added `env: gitEnv()`, wrapped error with `redactSecrets()`.
6. **shell tool** — Wrapped both success output and error output with `redactSecrets()`.

## Deviations from Plan

None. All 6 tasks executed exactly as specified.

## Self-Check

- [x] All 5 git push URLs use tokenless `https://github.com/...` format
- [x] All 5 execSync git calls include `env: gitEnv()`
- [x] All 4 error handlers wrap stderr with `redactSecrets()`
- [x] Shell tool output (success + error) passes through `redactSecrets()`
- [x] `setupGitAuth()` called at startup before any tool execution
- [x] TypeScript compiles without errors: `npx tsc --noEmit`

**Result: PASSED**
