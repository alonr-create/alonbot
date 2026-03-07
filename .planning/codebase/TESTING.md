# AlonBot — Testing

## Current State: No Tests

**There are no tests in this codebase.** This is documented clearly so future planning can account for it.

### Evidence
- No test files exist in `src/` or any project directory (no `*.test.ts`, `*.spec.ts`)
- No test framework installed — `package.json` has no test-related dependencies (no jest, vitest, mocha, chai, etc.)
- No test script in `package.json` — the `scripts` section contains only `dev`, `build`, and `start`
- No test configuration files (no `jest.config.*`, `vitest.config.*`, `.mocharc.*`)
- No CI/CD pipeline config (no `.github/workflows/`, no CI scripts)
- `.gitignore` has no test-related entries (no `coverage/`, no `.nyc_output/`)

### Test-related files in `node_modules/`
Some transitive dependencies (pino, sonic-boom, thread-stream) include their own test files. These are library tests, not project tests.

---

## Testing Challenges

The codebase has several characteristics that would make testing non-trivial:

### 1. Module-Level Side Effects
- `src/utils/db.ts` — creates database, runs migrations, and loads extensions at import time
- `src/utils/config.ts` — reads `.env` at import time via `import 'dotenv/config'`
- `src/agent/memory.ts`, `src/agent/knowledge.ts`, `src/agent/batch.ts`, `src/cron/scheduler.ts` — all create prepared statements at module scope (immediately on import)
- This means importing any module triggers real database initialization

### 2. Global Mutable State
- `src/agent/tools.ts` — `currentRequestId` and `pendingMediaMap` are module-level mutable state
- `src/gateway/router.ts` — `adapters` Map is module-level
- `src/agent/agent.ts` — `rateLimitMap` is module-level
- `src/cron/scheduler.ts` — `activeTasks` Map and `currentSendFn` are module-level

### 3. External Dependencies
- Claude API (Anthropic SDK)
- Gemini API (direct fetch)
- Groq Whisper API (direct fetch)
- ElevenLabs TTS API (direct fetch)
- Monday.com GraphQL API (direct fetch)
- Telegram Bot API (grammY SDK)
- WhatsApp (Baileys SDK)
- DuckDuckGo search (direct fetch)
- Google Calendar Apps Script (direct fetch)
- Gmail (nodemailer)
- SQLite on disk (`data/alonbot.db`)
- Shell command execution (`execSync`, `spawn`)
- Filesystem access (`readFileSync`, `writeFileSync`)

### 4. No Dependency Injection
- All dependencies are direct imports — no constructor injection, no factory parameters for swapping implementations
- Database is a singleton (`export { db }`)
- Config is a singleton (`export const config = { ... }`)
- The `executeTool()` function is a 900+ line switch statement with inline implementations

---

## Recommendations for Future Testing

### Quick Wins (Unit Tests)
These pure/near-pure functions could be tested without mocking:

| Function | File | Why |
|----------|------|-----|
| `matchesCronNow()` | `src/index.ts` | Pure function, cron expression matching |
| `isPathAllowed()` | `src/agent/tools.ts` | Pure path validation |
| `isUrlAllowed()` | `src/agent/tools.ts` | Pure URL validation |
| `isEmailAllowed()` | `src/agent/tools.ts` | Pure email whitelist check |
| `chunkText()` | `src/agent/knowledge.ts` | Pure text chunking |
| `detectCategory()` | `src/agent/memory.ts` | Pure keyword detection |
| `jidToNumber()` | `src/channels/whatsapp.ts` | Pure string transformation |
| `stripMention()` | `src/channels/telegram.ts` | Pure string transformation |
| `escapeJsString()` | `src/gateway/server.ts` | Pure string escaping |

### Suggested Framework
**Vitest** would be the natural choice:
- Native ESM support (matches project's `"type": "module"`)
- TypeScript support out of the box
- Fast startup, compatible with `tsx`
- Can use `vi.mock()` for module mocking

### Test Structure (if implemented)
```
src/
  __tests__/           or    tests/
    agent/
      tools.test.ts          — tool validation functions
      memory.test.ts         — memory CRUD (with test DB)
      knowledge.test.ts      — chunking logic
    utils/
      config.test.ts         — config parsing
    channels/
      telegram.test.ts       — message formatting
```

### Prerequisites for Integration Tests
1. Extract database initialization into a factory function that accepts a path (for test DBs)
2. Extract config into a factory function or make it injectable
3. Consider extracting the `executeTool()` switch cases into individual tool modules
4. Mock external API calls (Anthropic, Gemini, Groq, etc.)

---

## Coverage

No coverage data exists. No coverage tooling is configured.
