---
phase: 1
status: gaps_found
date: 2026-03-07
---

# Phase 1: Security Hardening -- Verification

## Success Criteria Check

### 1. Shell injection blocked (rm -rf /, curl | sh)
**PASS**

- `src/utils/shell-blocklist.ts` defines `BLOCKED_SHELL_PATTERNS` with 25 patterns covering: filesystem destruction (`rm -rf /`, `mkfs`, `dd`), fork bombs, remote code execution (`curl|bash`, `wget|sh`), privilege escalation, reverse shells, eval injection, credential theft, history wiping, and more.
- `isShellCommandSafe()` is a pure function returning `{ safe: boolean, reason?: string }`.
- **Shell tool** (`src/agent/tools.ts` line 319): `isShellCommandSafe(input.command)` is called before `execSync`. If blocked, returns `Error: Command blocked -- ${reason}`.
- **Cron scheduler** (`src/cron/scheduler.ts` line 50): `isShellCommandSafe(parsed.script)` is called before script execution. If blocked, logs the reason and notifies the user.
- Evidence: Lines 318-322 in tools.ts, lines 49-57 in scheduler.ts.

### 2. Dashboard uses cookie-based session -- no token in URL bar
**PASS**

- `src/gateway/server.ts` lines 70-169: Full cookie-based session implementation with:
  - Session store (`Map<string, { createdAt }>`) with 7-day TTL.
  - Rate limiting (5 failures per minute per IP).
  - `parseCookies()` manual cookie parser.
  - `dashAuth` middleware checks: rate limit -> session cookie -> query token (sets HttpOnly cookie + redirects to strip token) -> header token -> 401.
- Token-to-cookie flow: `/dashboard?token=SECRET` sets `alonbot_session` cookie (HttpOnly, SameSite=Lax, Secure when HTTPS) then redirects to `/dashboard` (302), stripping the token from the URL bar.
- `getDashboardHTML()` and `getChatHTML()` take no token parameter. No `const TOKEN` or `?token=` appears in the inline JS after line 310.
- All `/api/dashboard/*` and `/api/chat/*` endpoints use `dashAuth` middleware which accepts the cookie.
- Evidence: Lines 118-169 (dashAuth), 288-297 (routes), 310+ (HTML without token).

### 3. git remote -v never shows GitHub token in output
**PASS (with one gap -- see below)**

- `src/utils/git-auth.ts`: `setupGitAuth()` writes a `GIT_ASKPASS` script to `/tmp/alonbot-git-askpass.sh`. `gitEnv()` returns env with `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT=0`. `redactSecrets()` strips `ghp_*`, `gho_*`, `github_pat_*`, embedded URL credentials, `sk-ant-*`, Bearer tokens, and the literal `GITHUB_TOKEN` value.
- `setupGitAuth()` is called at startup (`src/index.ts` line 14).
- **deploy_app** (lines 902-905, 923-926): Uses tokenless `pushUrl` (`https://github.com/...`) with `env: gitEnv()`. Error output at line 934 uses `redactSecrets`.
- **auto_improve** (line 1008-1010): Uses tokenless URL with `env: gitEnv()`. Error at line 1014 uses `redactSecrets`.
- **build_website** (line 1044, 1059-1061): Uses tokenless `pushUrl` with `env: gitEnv()`. Error at line 1066 uses `redactSecrets`.
- **Shell tool output** (lines 325, 327): Both success and error are wrapped in `redactSecrets`.

**GAP: `create_github_repo`** (line 863): Still embeds token directly in push URL (`cloneUrl.replace('https://', 'https://${token}@')`), does NOT use `gitEnv()`, and error handler (line 874) does NOT use `redactSecrets`. If this tool's git push fails, the token could leak in the error message sent to Telegram. However, the shell tool's `redactSecrets` wrapper would catch it if the user ran `git remote -v` manually afterward, since `redactSecrets` strips the literal token value and URL credential patterns. The direct risk is limited to the error path of `create_github_repo` itself.

### 4. Invalid type returns validation error instead of crash
**PASS**

- `src/agent/tools.ts` lines 17-40: 10 Zod schemas defined for high-risk tools (`shell`, `write_file`, `send_email`, `deploy_app`, `auto_improve`, `set_reminder`, `browse_url`, `monday_api`, `code_agent`, `cron_script`).
- `TOOL_SCHEMAS` record maps tool names to schemas (lines 29-40).
- `executeTool()` lines 293-302: Zod validation runs at the very top, before any tool logic. On failure, returns `Validation error: path: message; ...` instead of crashing.
- Example: Passing `{ command: "" }` to shell returns "Validation error: command: String must contain at least 1 character(s)". Passing a string where a number is expected to `code_agent.max_budget` returns a type validation error.

## Requirement Coverage

- **SEC-01** (Shell blocklist): **PASS** -- Blocklist in `shell-blocklist.ts`, integrated in both `tools.ts` (shell handler) and `scheduler.ts` (cron scripts). 25 patterns cover all specified categories.

- **SEC-02** (Token not in git remotes/output): **PARTIAL** -- 5 of 6 git push locations use `gitEnv()` with tokenless URLs. `redactSecrets` is applied to shell output and all deploy/build/auto_improve error messages. **Gap: `create_github_repo` (line 863) still embeds token in URL and error output is not redacted.**

- **SEC-03** (Cookie-based dashboard auth): **PASS** -- HttpOnly cookie sessions with 7-day TTL, redirect to strip token from URL, rate limiting on auth failures (5/min).

- **SEC-04** (Tool parameter validation): **PASS** -- Zod schemas for 10 tools, validated at top of `executeTool()` before any logic runs. Invalid input returns descriptive validation errors.

- **SEC-05** (Separate secrets): **PASS** -- `config.ts` line 19: `dashboardSecret` falls back to `LOCAL_API_SECRET` but can be set independently via `DASHBOARD_SECRET` env var. `dashAuth` uses `config.dashboardSecret` (line 141, 161). Bridge endpoints (`/api/register-local` line 27, `/api/tool` line 47) use `config.localApiSecret`.

## Gaps

### GAP-1: `create_github_repo` token embedding (SEC-02 partial)
- **File**: `src/agent/tools.ts` line 863
- **Issue**: `const pushUrl = cloneUrl.replace('https://', 'https://${token}@');` embeds GITHUB_TOKEN in the URL. `execSync` at line 864 does not pass `env: gitEnv()`. Error handler at line 874 does not wrap output with `redactSecrets()`.
- **Risk**: Medium. Token could appear in `git remote -v` output for repos created via this tool, and could leak in error messages. The shell tool's `redactSecrets` wrapper mitigates the `git remote -v` scenario but not the direct error path.
- **Fix**: Replace line 863 with tokenless URL, add `env: gitEnv()` to execSync options, wrap error with `redactSecrets()`.

## Human Verification Needed

1. **Runtime test**: Send "Run `rm -rf /`" via Telegram and confirm the bot returns "Error: Command blocked" (not executed).
2. **Browser test**: Open `/dashboard?token=SECRET` and confirm the URL bar shows `/dashboard` after redirect, and DevTools shows `alonbot_session` cookie with HttpOnly flag.
3. **Rate limit test**: Send 6 rapid requests with wrong token to `/dashboard?token=WRONG` and confirm the 6th returns HTTP 429.
4. **Validation test**: Trigger a tool with invalid parameters (e.g., `send_email` with non-email address) and confirm it returns a validation error.
5. **Secret separation test**: Set `DASHBOARD_SECRET=test123` in `.env` and confirm dashboard accepts `test123` while `/api/register-local` still requires `LOCAL_API_SECRET`.
