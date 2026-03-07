import { z } from 'zod';
import { execAsync } from '../../utils/shell.js';
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
      const output = await execAsync(input.command, { shell: '/bin/zsh', timeout: 30000, maxBuffer: 1_000_000 });
      return redactSecrets(output);
    } catch (e: any) {
      return `Error: ${redactSecrets((e.stderr || e.message || '').slice(0, 1000))}`;
    }
  },
};

export default handler;
