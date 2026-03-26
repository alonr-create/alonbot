# Testing Patterns

**Analysis Date:** 2026-03-26

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in expect API (compatible with Jest)

**Run Commands:**
```bash
npm run test              # Run tests via vitest
npm run dev              # Watch mode with tsx (for development)
npm run build            # Compile TypeScript for production
```

**Configuration:**
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

## Test File Organization

**Location:**
- Tests live in `/Users/oakhome/קלוד עבודות/alonbot/tests/` directory
- Pattern: co-located by function, not by file name
- Single test file: `tests/utils.test.ts`

**Naming:**
- Convention: `*.test.ts` suffix
- Module organization: one test file per major utility module

**Directory Structure:**
```
tests/
└── utils.test.ts              # Security, HTML, retry, and sanitization tests
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect } from 'vitest';
import { stripHtml } from '../src/utils/html.js';
import { isUrlAllowed, isEmailAllowed } from '../src/utils/security.js';
import { isShellCommandSafe } from '../src/utils/shell-blocklist.js';
import { sanitizeWebContent } from '../src/utils/sanitize.js';
import { withRetry } from '../src/utils/retry.js';

// --- Group related tests by feature ---
describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script tags and content', () => {
    expect(stripHtml('before<script>alert("xss")</script>after')).toBe('beforeafter');
  });
});
```

**Patterns:**
- Setup: Import functions at top, describe blocks for feature grouping
- Teardown: None currently used (all tests are pure functions)
- Assertion: Direct `expect(...).toBe(...)` or `expect(...).rejects.toThrow(...)`

## Test Coverage Areas

**Security Module (`src/utils/security.ts`):**
- `isUrlAllowed()`: HTTPS/HTTP validation, localhost/private IP blocking, protocol blocking
- `isEmailAllowed()`: Whitelist enforcement (addresses and domains), case-insensitive matching
- `isPathAllowed()`: File path restrictions, symlink escape prevention

**HTML Module (`src/utils/html.ts`):**
- `stripHtml()`: Tag removal, script/style stripping, whitespace collapsing

**Shell Command Blocklist (`src/utils/shell-blocklist.ts`):**
- `isShellCommandSafe()`: Dangerous command detection
  - Fork bombs, rm -rf patterns
  - Pipe to shell (curl | sh)
  - Reverse shells (nc -e, /dev/tcp)
  - Credential access (.env, .ssh)
  - System manipulation (shutdown, reboot)

**Content Sanitization (`src/utils/sanitize.ts`):**
- `sanitizeWebContent()`: Prompt injection filtering, fake tool tag removal, HTML comment stripping

**Retry Utility (`src/utils/retry.ts`):**
- `withRetry()`: Success on first try, retry on retryable errors (5xx, 429), throw on non-retryable, max retries enforcement

## Mocking

**Framework:**
- Not currently used in the test suite
- Tests are pure functions with no external dependencies

**What Tests Are:**
- Unit tests of utility validation functions
- Input-output behavior testing
- Security boundary testing

**What NOT to Mock:**
- Database queries — tools would need integration testing (not implemented)
- HTTP requests — integration testing only
- File system — use temporary files or in-memory alternatives

**Why No Mocking:**
- All tested functions are pure (no side effects)
- Security validators are deterministic
- Tool handlers are tested manually via bot interaction

## Fixtures and Factories

**Test Data:**
- Inline strings for simple cases
- Hardcoded test inputs:
  ```typescript
  it('allows whitelisted addresses', () => {
    expect(isEmailAllowed('alon12@gmail.com')).toBe(true);
    expect(isEmailAllowed('dekel@dprisha.co.il')).toBe(true);
  });
  ```

**Location:**
- No separate fixtures directory
- Test data defined directly in test cases
- Inline: keeps tests self-contained and readable

## Coverage

**Requirements:**
- No enforced coverage threshold
- Current: ~6 test cases covering core security/validation functions

**View Coverage:**
```bash
npm run test -- --coverage    # Not currently configured
```

**Gap Analysis:**
- Missing: Tool handler execution tests (require mocking or integration setup)
- Missing: Database operation tests (would need test DB setup)
- Missing: Channel adapter tests (would need socket/webhook mocking)
- Missing: Agent/memory tests (complex state management)
- Present: Security boundary tests (highest priority)

## Test Types

**Unit Tests:**
- Scope: Individual functions in `src/utils/`
- Approach: Pure function testing, input validation, boundary conditions
- Example: `stripHtml()`, `isUrlAllowed()`, `isShellCommandSafe()`

**Integration Tests:**
- Not yet implemented
- Would require: Tool handler mocks, database test instance, channel adapters
- Candidates: Message routing (`src/gateway/router.ts`), tool execution flow

**E2E Tests:**
- Not implemented
- Would require: Full bot instance, test Telegram/WhatsApp numbers, database
- Approach: Manual testing via bot conversation currently

## Common Patterns

**Pure Function Testing:**
```typescript
describe('isUrlAllowed', () => {
  it('allows HTTPS URLs', () => {
    expect(isUrlAllowed('https://example.com')).toBe(true);
  });

  it('blocks localhost', () => {
    expect(isUrlAllowed('http://localhost')).toBe(false);
    expect(isUrlAllowed('http://127.0.0.1')).toBe(false);
    expect(isUrlAllowed('http://0.0.0.0')).toBe(false);
  });
});
```

**Error Testing:**
```typescript
it('throws on non-retryable error', async () => {
  await expect(
    withRetry(
      () => {
        throw new Error('Bad request');
      },
      { baseDelay: 10 }
    )
  ).rejects.toThrow('Bad request');
});
```

**Async Testing:**
```typescript
it('returns on first success', async () => {
  const result = await withRetry(() => Promise.resolve(42));
  expect(result).toBe(42);
});

it('retries on retryable error', async () => {
  let attempts = 0;
  const result = await withRetry(
    () => {
      attempts++;
      if (attempts < 3) {
        const err: any = new Error('Server error');
        err.status = 500;
        throw err;
      }
      return Promise.resolve('ok');
    },
    { baseDelay: 10, maxDelay: 50 }
  );
  expect(result).toBe('ok');
  expect(attempts).toBe(3);
});
```

## Test Execution

**Run All Tests:**
```bash
npm run test
```

**Run Specific Test Suite:**
```bash
npx vitest run tests/utils.test.ts
```

**Watch Mode:**
```bash
npx vitest watch tests/
```

**Expected Output:**
```
✓ tests/utils.test.ts (all passed)
  ✓ stripHtml (5 tests)
  ✓ isUrlAllowed (6 tests)
  ✓ isEmailAllowed (4 tests)
  ✓ isShellCommandSafe (multiple tests)
  ✓ sanitizeWebContent (multiple tests)
  ✓ withRetry (4 tests)
```

## Testing Best Practices (Applied)

**What Works Well:**
1. Pure function testing prevents flaky tests
2. Security validators are core to bot safety — well tested
3. Inline test data keeps tests readable and self-contained
4. Async retry testing validates backoff behavior

**What Could Be Added:**
1. Tool handler integration tests (mock tool context, verify execution)
2. Database tests with in-memory SQLite instance
3. Channel adapter tests with stubbed socket connections
4. Agent message routing tests with fake adapters
5. Coverage reporting via `--coverage` flag

## Current Test Gaps and Impact

**Untested Areas:**

1. **Tool Handlers** (`src/tools/handlers/`)
   - What's not tested: Handler execution, input validation via schema, media collection
   - Files: All handler files
   - Risk: A handler may execute with invalid input without error
   - Priority: High — tool execution is critical path

2. **Database Layer** (`src/utils/db.ts`)
   - What's not tested: CRUD operations, prepared statements, vector search
   - Files: `src/utils/db.ts`, `src/agent/memory.ts`
   - Risk: Silent failures in memory storage, message history loss
   - Priority: Medium — data corruption would be severe but would be visible quickly

3. **Channel Adapters** (`src/channels/`)
   - What's not tested: Message routing, webhook handling, reconnection logic
   - Files: `src/channels/telegram.ts`, `src/channels/whatsapp.ts`, `src/channels/whatsapp-cloud.ts`
   - Risk: Messages may silently fail to route or cause crashes
   - Priority: High — channel failures block all communication

4. **Message Router** (`src/gateway/router.ts`)
   - What's not tested: Deduplication, cloud sync, tool execution flow
   - Files: `src/gateway/router.ts`, `src/gateway/server.ts`
   - Risk: Duplicate messages, lost tool results, misrouted responses
   - Priority: Medium — would be visible in testing

5. **Agent/AI Logic** (`src/agent/`)
   - What's not tested: System prompt application, memory injection, streaming
   - Files: `src/agent/agent.ts`, `src/agent/memory.ts`, `src/agent/workflows.ts`
   - Risk: Wrong responses, memory inconsistencies, workflow failures
   - Priority: Medium — manual bot testing currently sufficient

---

*Testing analysis: 2026-03-26*
