# Coding Conventions

**Analysis Date:** 2026-03-26

## Naming Patterns

**Files:**
- TypeScript source files: `kebab-case.ts` (e.g., `whatsapp-cloud.ts`, `shell-blocklist.ts`)
- Handler files in `src/tools/handlers/`: named after their tool (e.g., `remember.ts`, `web-search.ts`)
- Database utilities: descriptive names (`db.ts`, `migrate.ts`)
- Channel adapters: `{channel}.ts` (e.g., `telegram.ts`, `whatsapp.ts`)

**Functions:**
- camelCase for regular functions (e.g., `isPathAllowed`, `withRetry`, `jidToNumber`)
- Constants uppercase with underscores (e.g., `MAX_RETRIES`, `SESSION_DIR`, `BLOCKED_FILE_PATTERNS`)
- Logger creation: `createLogger(moduleName)` pattern (`src/utils/logger.ts`)
- Prepared database statements: `stmtXxxYyy` prefix (e.g., `stmtInsertMemory`, `stmtHighImportance`)

**Variables:**
- camelCase for variables (e.g., `retryCount`, `shouldReconnect`, `messageHandler`)
- Prefixed booleans with `is`, `should`, `has` (e.g., `isPathAllowed`, `shouldReconnect`, `hasTag`)
- Map objects use snake_case for clarity (e.g., `recentMessageIds`, `lidToPhone`)

**Types:**
- Interfaces: PascalCase, descriptive (e.g., `ToolHandler`, `ChannelAdapter`, `UnifiedMessage`)
- Type imports: explicit `type` keyword (e.g., `import type Anthropic from '@anthropic-ai/sdk'`)
- Readonly/const types: `as const` suffix for tuple types (e.g., `(['A', 'B', 'C'] as const)[sum % 3]`)

## Code Style

**Formatting:**
- No ESLint or Prettier config in project — formatting is manual/TypeScript compiler-enforced
- Indentation: 2 spaces (observed across all source files)
- Line length: pragmatic, typically under 100 chars for readability

**Linting:**
- TypeScript strict mode enabled (`"strict": true` in `tsconfig.json`)
- Target: ES2022, Module: NodeNext (ESM with `.js` extension imports)
- Type checking on imports (e.g., `import type { ToolHandler } from '../types.js'`)

**Import Organization:**

Order:
1. Core Node.js imports first (`import crypto from 'crypto'`)
2. Third-party library imports (`import Database from 'better-sqlite3'`)
3. Local imports by category:
   - Gateway/server imports
   - Channel adapters
   - Agent/tool imports
   - Utility imports
4. All imports use explicit `.js` extension (TypeScript ESM convention)

**Path Aliases:**
- No path aliases configured — all imports use relative paths
- Prefer `import.meta.dirname` for file operations (Node.js 18+)

Example from `src/index.ts`:
```typescript
import { startServer, registerWebhook } from './gateway/server.js';
import { registerAdapter, sendToChannel } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { config } from './utils/config.js';
import { createLogger } from './utils/logger.js';
```

## Error Handling

**Patterns:**
- Try-catch blocks for async operations: explicit error message capture
- Type narrowing: `err: any` in catch blocks with property checks
- Fallback values: Use nullish coalescing (`||`) for configuration defaults
- Silent failures permitted in non-critical paths: `try { } catch {} // best-effort`

**Logger integration:**
- All modules create logger via `const log = createLogger('moduleName')`
- Structured logging: pass objects with context (e.g., `log.info({ attempt, maxRetries, err: err.message }, 'retrying')`)
- Error level: `log.warn()` for recoverable errors, `log.error()` for critical failures

**HTTP Error Handling:**
- Retry on 5xx and 429 status codes (see `src/utils/retry.ts`)
- Custom `withRetry` wrapper with exponential backoff:
  ```typescript
  export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T>
  ```

**Security-First Error Handling:**
- Never expose API keys or .env values in logs
- Sanitize user input before logging (see `src/utils/sanitize.ts`)
- Path validation before file operations (`isPathAllowed()`)
- URL validation before HTTP requests (`isUrlAllowed()`)

## Logging

**Framework:** Pino (`pino` package, `src/utils/logger.ts`)

**Patterns:**
- Create module logger at top: `const log = createLogger('moduleName')`
- Use structured logging for context: `log.info({ key: value, another: data }, 'message')`
- Log levels: `info`, `warn`, `debug`, `error`
- Startup/shutdown events logged at `info`
- Retries logged at `warn`

**Configuration:**
- Log level: `process.env.LOG_LEVEL || 'info'` (default: info)
- Timestamp auto-included by Pino
- Child loggers per module for filtering

## Comments

**When to Comment:**
- Complex algorithm explanations (e.g., "Assign deterministically: sum of digits mod 3")
- Security-critical decisions (e.g., "symlink escape prevention")
- Non-obvious workarounds (e.g., "Close previous socket to prevent self-conflict")
- Section headers for major blocks (e.g., "--- Telegram ---", "--- DND check ---")

**JSDoc/TSDoc:**
- Minimal use — types are self-documenting via TypeScript
- Document public APIs and handler interfaces
- Parameter descriptions in tool definitions (Anthropic schema)

**Example from `src/gateway/server.ts`:**
```typescript
// Cache HTML at startup (no server-side variables needed)
const dashboardHTML = readFileSync(join(import.meta.dirname, '../views/dashboard.html'), 'utf-8');

// ── A/B/C Price Tier System ──
// Deterministic assignment: hash phone → consistent tier per lead
const PRICE_TIERS = { ... };
```

## Function Design

**Size:**
- Typical: 10-50 lines per function
- Complex tools may reach 80-100 lines (e.g., WhatsApp adapter connection logic)
- Break long operations into helper functions (e.g., `jidToNumber()`, `isLidJid()`)

**Parameters:**
- Keep to max 4-5 parameters; use options objects for more
- Tool handlers receive standard tuple: `(input: Record<string, any>, ctx: ToolContext)`
- Use destructuring in parameters when possible

**Return Values:**
- Async functions return Promise: `Promise<T>`
- Tool handlers always return `Promise<string>` (result message)
- Void functions rare; prefer returning status or count

**Async/Await:**
- Preferred over `.then()` chains
- Error propagation via try-catch
- Top-level awaits allowed in ESM modules (e.g., `src/index.ts`)

Example from `src/tools/registry.ts`:
```typescript
export async function loadTools(): Promise<void> {
  const handlersDir = join(import.meta.dirname, 'handlers');
  const files = readdirSync(handlersDir).filter(f => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts'));

  for (const file of files) {
    const mod = await import(pathToFileURL(join(handlersDir, file)).href);
    const exported = mod.default;
    // ... validation and registration
  }
}
```

## Module Design

**Exports:**
- Default exports for single main item: `export default handler`
- Named exports for utilities and types: `export function isPathAllowed()`
- Re-exports in index files for backward compatibility

**Barrel Files:**
- Limited use — most imports direct to source files
- `src/agent/tools.ts` re-exports from `src/tools/` for compatibility

**Const/Object Patterns:**
- Configuration objects as `export const`: `src/utils/config.ts`
- Tool definitions as `default export`: handlers in `src/tools/handlers/`
- Constants prefixed with underscore in private maps: `const _handlers = new Map()`

**Zod Validation:**
- Optional schema property on ToolHandler for input validation
- Validation happens at execution time: `handler.schema.safeParse(input)`
- Return validation errors as tool result string (not exception)

## Database Patterns

**Prepared Statements:**
- All database operations use `db.prepare()` for safety
- Statement objects prefixed `stmt`: `stmtInsertMemory`, `stmtSearchMemories`
- Defined once at module load, reused throughout

**Connection:**
- Single SQLite instance: `src/utils/db.ts` exports `db`
- WAL mode enabled: `db.pragma('journal_mode = WAL')`
- Foreign keys enabled: `db.pragma('foreign_keys = ON')`

## Type Safety

**Zod Schema Usage:**
- Import: `import { z } from 'zod'`
- Tool handlers may include `schema?: z.ZodType<any>`
- Validation at execution: check `result.success` and return errors as string

**Type Assertions:**
- Minimal use; prefer `as const` for literal narrowing
- Cast in database queries: `as any` when needed (e.g., `const lead = db.prepare(...).get(phone) as any`)

**Strict Mode Benefits:**
- No implicit `any`
- Strict null checks (handle undefined/null explicitly)
- All types inferred or explicitly declared

---

*Convention analysis: 2026-03-26*
