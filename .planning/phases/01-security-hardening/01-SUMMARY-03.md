# Summary: Plan 3 — Cookie-Based Dashboard Auth & Separate Secrets

## What Was Built

Replaced query-parameter token authentication with HttpOnly cookie-based sessions for the dashboard and chat pages. Added IP-based rate limiting on auth failures. Split the shared `localApiSecret` into two separate secrets: `localApiSecret` for cloud-local bridge and `dashboardSecret` for dashboard/chat auth.

## Key Changes

### `src/utils/config.ts`
- Added `dashboardSecret` field with fallback chain: `DASHBOARD_SECRET` env var -> `LOCAL_API_SECRET` env var -> `'alonbot-dash-2026'`

### `src/gateway/server.ts`
- Added `crypto` import for secure session token generation
- Added session store (`sessions` Map with 7-day TTL)
- Added rate limiting store (`authFailures` Map, 5 failures per minute per IP)
- Added helper functions: `getClientIp()`, `isRateLimited()`, `recordAuthFailure()`, `parseCookies()`
- Replaced `dashAuth` middleware: checks rate limit -> session cookie -> query token (sets cookie + redirects) -> header token -> 401
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=7d`, `Secure` when behind HTTPS
- HTML page requests (`/dashboard`, `/chat`) redirect after cookie set to strip token from URL
- Updated `getDashboardHTML()` and `getChatHTML()` — removed `token` parameter, removed `safeToken`/`TOKEN` from inline JS
- Dashboard API helper changed from `'/api/dashboard/' + path + '?token=' + TOKEN` to `'/api/dashboard/' + path`
- Chat fetch calls no longer include `?token=` in URLs
- Chat-to-dashboard link changed from `/dashboard?token=...` to `/dashboard`
- Startup log URLs now use `config.dashboardSecret` instead of `config.localApiSecret`
- Removed `escapeJsString()` function (no longer used)

## Bridge Endpoints (Verified Unchanged)
- `/api/register-local` (line 27): still uses `config.localApiSecret`
- `/api/tool` (line 47): still uses `config.localApiSecret`

## Deviations from Plan
None. All 8 tasks executed exactly as specified.

## Self-Check

- [x] `npx tsc --noEmit` — **PASSED** (zero errors)
- [x] Dashboard/chat use HttpOnly cookie sessions
- [x] Rate limiting blocks after 5 failed attempts per minute
- [x] `dashboardSecret` separate from `localApiSecret`
- [x] No token in inline JS fetch URLs
- [x] `escapeJsString` removed (no remaining uses)
- [x] Bridge endpoints unchanged

**Result: PASSED**
