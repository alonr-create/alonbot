import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'screenshot',
  definition: {
    name: 'screenshot',
    description: 'Screenshot Mac screen',
    input_schema: { type: 'object' as const, properties: {} },
  },
  localOnly: true,
  async execute(input, ctx) {
    try {
      const tmpPath = `/tmp/alonbot-screenshot-${Date.now()}.png`;
      execSync(`screencapture -x ${tmpPath}`, { timeout: 5000 });
      const buf = readFileSync(tmpPath);
      try { unlinkSync(tmpPath); } catch {}
      ctx.addPendingMedia({ type: 'image', data: buf });
      return 'Screenshot taken and sent.';
    } catch (e: any) {
      return `Error: Screenshot failed.`;
    }
  },
};

export default handler;
