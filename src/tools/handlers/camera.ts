import { readFileSync, unlinkSync, existsSync } from 'fs';
import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'camera',
  definition: {
    name: 'camera',
    description: 'Take a photo using the Mac webcam (FaceTime camera)',
    input_schema: { type: 'object' as const, properties: {} },
  },
  localOnly: true,
  async execute(input, ctx) {
    const tmpPath = `/tmp/alonbot-camera-${Date.now()}.jpg`;
    try {
      // Use AppleScript to invoke imagesnap via Terminal context (gets camera permission)
      await execAsync(
        `osascript -e 'do shell script "/opt/homebrew/bin/imagesnap -w 1 ${tmpPath}"'`,
        { timeout: 15000 }
      );
      if (!existsSync(tmpPath)) throw new Error('Photo file not created');
      const buf = readFileSync(tmpPath);
      try { unlinkSync(tmpPath); } catch { /* cleanup */ }
      ctx.addPendingMedia({ type: 'image', data: buf });
      return 'Photo taken from webcam and sent.';
    } catch {
      // Fallback: try direct call
      try {
        await execAsync(`/opt/homebrew/bin/imagesnap -w 1 ${tmpPath}`, { timeout: 15000 });
        if (!existsSync(tmpPath)) throw new Error('No file');
        const buf = readFileSync(tmpPath);
        try { unlinkSync(tmpPath); } catch { /* cleanup */ }
        ctx.addPendingMedia({ type: 'image', data: buf });
        return 'Photo taken from webcam and sent.';
      } catch (e: any) {
        return `Error: Camera not available — ${e.message || 'unknown'}. Camera permission may need to be granted in System Settings > Privacy > Camera for bash/node.`;
      }
    }
  },
};

export default handler;
