# Phase 1: Security Hardening - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Eliminate all critical and high-severity security vulnerabilities: shell command injection, token leakage, dashboard auth bypass, and missing input validation. The bot must remain fully functional — no features removed, only secured.

</domain>

<decisions>
## Implementation Decisions

### Shell sandboxing policy
- **Blocklist approach** — block known destructive patterns (rm -rf /, curl|sh, chmod 777, mkfs, dd, :(){ etc.) but allow everything else
- Same blocklist applies to both the `shell` tool and `cron_script` scheduled execution
- Blocklist is a centralized array/set in one place, easy to extend
- Both cloud and local modes use the same blocklist

### auto_improve restrictions
- Keep the tool but restrict which files it can modify
- **Allowed**: `src/agent/system-prompt.ts`, `skills/` directory
- **Blocked**: `src/agent/tools.ts`, `src/gateway/server.ts`, security-related code, `.env`, `package.json`
- The restriction is enforced in the tool handler, not just in the system prompt

### Prompt injection mitigation
- Sanitize content from `browse_url` and `scrape_site` before feeding to Claude
- Strip suspicious patterns: encoded shell commands, "ignore previous instructions" variants, code blocks with shell/bash/eval content
- This is defense-in-depth — the blocklist is the primary defense, sanitization is secondary

### Token & secret handling
- Use `git credential helper` or environment-based auth instead of embedding GITHUB_TOKEN in git remote URLs
- Redact any token patterns from tool output before sending to Telegram
- Separate secrets for dashboard auth vs cloud-local bridge (two different env vars)

### Dashboard auth
- Move from query-param token to HttpOnly cookie-based session
- Set cookie on first authenticated request, subsequent requests use cookie
- Add rate limiting on auth failures (5 attempts per minute)

### Input validation
- Validate high-risk tools first: shell, send_email, deploy_app, code_agent, auto_improve
- Type checking + range validation on numeric parameters
- Path traversal prevention on file operations
- URL validation on web-facing tools

### Claude's Discretion
- Exact blocklist patterns for shell commands
- Cookie session implementation details (expiry, secure flags)
- Specific sanitization regex patterns for prompt injection
- Which additional tools beyond high-risk need validation
- Rate limiting implementation approach

</decisions>

<specifics>
## Specific Ideas

No specific requirements — standard security hardening practices apply.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `isUrlAllowed()` in `src/agent/tools.ts:52-68` — existing SSRF prevention, can be extended
- `ALLOWED_FILE_DIRS` and `BLOCKED_FILE_PATTERNS` in `src/agent/tools.ts` — existing path restriction pattern
- `dashAuth` middleware in `src/gateway/server.ts:70-77` — needs upgrade from token to cookie

### Established Patterns
- Security checks are inline in tool handlers (no middleware pattern for tools)
- `config.localApiSecret` is the shared secret — needs splitting into two
- Error messages go directly to Telegram via `adapter.sendReply()` — need to ensure redacted

### Integration Points
- Shell execution: `src/agent/tools.ts:280` (shell tool), `src/cron/scheduler.ts:50` (cron scripts)
- Token usage: `src/agent/tools.ts:818-819,857-858,877-878,940,975,990` (git URLs with GITHUB_TOKEN)
- Dashboard auth: `src/gateway/server.ts:70-77` (dashAuth middleware), lines 213,304,314,441 (token in URLs)
- auto_improve: `src/agent/tools.ts:906-956`
- Web content ingestion: `browse_url` and `scrape_site` tool handlers

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-security-hardening*
*Context gathered: 2026-03-07*
