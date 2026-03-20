import { readFileSync, unlinkSync } from 'fs';
import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'screenshot',
  definition: {
    name: 'screenshot',
    description: 'Screenshot Mac screen. Alon has 2 displays: 1=built-in laptop, 2=external monitor. When asked for "המסך השני" or "external", use display=2. Just call it — do NOT check if a display exists first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        display: { type: 'number', description: '1=built-in laptop screen, 2=external monitor. Omit for all displays combined.' },
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
