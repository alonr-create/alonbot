import { writeFileSync, chmodSync, unlinkSync } from 'fs';
import { createLogger } from './logger.js';

const log = createLogger('git-auth');

const ASKPASS_PATH = '/tmp/alonbot-git-askpass.sh';

/**
 * Write a GIT_ASKPASS script that echoes GITHUB_TOKEN.
 * Called once at startup so git never needs tokens in URLs.
 * Registers cleanup on process exit.
 */
export function setupGitAuth(): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn('GITHUB_TOKEN not set — GIT_ASKPASS not configured');
    return;
  }
  writeFileSync(ASKPASS_PATH, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });

  // Cleanup on process exit
  const cleanup = () => { try { unlinkSync(ASKPASS_PATH); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  log.info('GIT_ASKPASS configured');
}

/**
 * Returns env vars for execSync that use GIT_ASKPASS for authentication.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ASKPASS: ASKPASS_PATH,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Redact secret patterns from output strings (defense-in-depth).
 */
export function redactSecrets(output: string): string {
  let result = output;

  // GitHub tokens
  result = result.replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]');
  result = result.replace(/gho_[a-zA-Z0-9]{36,}/g, '[REDACTED]');
  result = result.replace(/github_pat_[a-zA-Z0-9_]{22,}/g, '[REDACTED]');

  // Embedded credentials in URLs
  result = result.replace(/:\/\/[^@\s]+@github\.com/g, '://[REDACTED]@github.com');

  // Anthropic keys
  result = result.replace(/sk-ant-[a-zA-Z0-9-]{20,}/g, '[REDACTED]');

  // Bearer tokens in output
  result = result.replace(/Bearer [a-zA-Z0-9._-]{20,}/g, 'Bearer [REDACTED]');

  // The actual GITHUB_TOKEN value itself
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length > 8) {
    result = result.split(token).join('[REDACTED]');
  }

  return result;
}
