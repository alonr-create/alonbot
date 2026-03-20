import { readFileSync, unlinkSync } from 'fs';
import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'screenshot',
  definition: {
    name: 'screenshot',
    description: 'Screenshot Mac screen. Use display=2 for the external monitor.',
    input_schema: {
      type: 'object' as const,
      properties: {
        display: { type: 'number', description: 'Display number: 1=main/built-in, 2=external monitor (default: all displays)' },
      },
    },
  },
  localOnly: true,
  async execute(input: any, ctx) {
    try {
      const tmpPath = `/tmp/alonbot-screenshot-${Date.now()}.png`;
      const displayFlag = input.display ? `-D ${input.display}` : '';
      await execAsync(`screencapture -x ${displayFlag} ${tmpPath}`, { timeout: 5000 });
      const buf = readFileSync(tmpPath);
      try { unlinkSync(tmpPath); } catch { /* temp file cleanup */ }
      ctx.addPendingMedia({ type: 'image', data: buf });
      return `Screenshot taken (display: ${input.display || 'all'}) and sent.`;
    } catch (e: any) {
      return `Error: Screenshot failed.`;
    }
  },
};

export default handler;
