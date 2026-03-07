import { z } from 'zod';
import { execSync } from 'child_process';
import { isShellCommandSafe } from '../../utils/shell-blocklist.js';
import { redactSecrets } from '../../utils/git-auth.js';
import type { ToolHandler } from '../types.js';

const shellSchema = z.object({
  command: z.string().min(1).max(10000),
});

const handler: ToolHandler = {
  name: 'shell',
  definition: {
    name: 'shell',
    description: 'Run any shell command on Mac (pipes, chaining, curl — all allowed)',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  schema: shellSchema,
  async execute(input) {
    const shellCheck = isShellCommandSafe(input.command);
    if (!shellCheck.safe) {
      return `Error: Command blocked — ${shellCheck.reason}`;
    }
    try {
      const output = execSync(input.command, { shell: '/bin/zsh', timeout: 30000, encoding: 'utf-8', maxBuffer: 1_000_000 }).trim();
      return redactSecrets(output);
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 1000))}`;
    }
  },
};

export default handler;
