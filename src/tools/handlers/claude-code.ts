import { execAsync } from '../../utils/shell.js';
import { createLogger } from '../../utils/logger.js';
import type { ToolHandler } from '../types.js';

const log = createLogger('claude-code');

const handler: ToolHandler = {
  name: 'claude_code',
  definition: {
    name: 'claude_code',
    description: 'Run Claude Code (CLI) on the Mac. Sends a prompt to Claude Code which can read/write files, run commands, and do development tasks. Use when Alon asks to "tell Claude" or wants a dev task done. Returns Claude Code\'s response.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The task/prompt to send to Claude Code' },
        cwd: { type: 'string', description: 'Working directory (default: ~/קלוד עבודות)' },
      },
      required: ['prompt'],
    },
  },
  localOnly: true,
  async execute(input: any, ctx) {
    try {
      const cwd = input.cwd || '/Users/oakhome/קלוד עבודות';
      const prompt = input.prompt;

      log.info({ prompt: prompt.slice(0, 100), cwd }, 'running claude-code');

      // Run claude in headless mode with 5 min timeout
      // --output-format text gives clean text output
      // Escape single quotes in prompt
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const result = await execAsync(
        `claude -p '${escapedPrompt}' --output-format text`,
        {
          cwd,
          timeout: 300_000, // 5 minutes
          maxBuffer: 500_000,
        }
      );

      log.info({ resultLen: result.length }, 'claude-code finished');

      // Truncate if too long for WhatsApp
      if (result.length > 3000) {
        return result.slice(0, 3000) + '\n\n... (קוצר — תוצאה ארוכה)';
      }
      return result || 'Claude Code completed (no output).';
    } catch (e: any) {
      const errMsg = e.stdout || e.stderr || e.message || 'Unknown error';
      log.error({ err: errMsg.slice(0, 200) }, 'claude-code failed');
      return `Error running Claude Code: ${errMsg.slice(0, 500)}`;
    }
  },
};

export default handler;
