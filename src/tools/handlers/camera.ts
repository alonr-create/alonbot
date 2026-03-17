import { readFileSync, unlinkSync, existsSync } from 'fs';
import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE_APP = join(__dirname, '../../../scripts/CaptureCamera.app/Contents/MacOS/CaptureCamera');

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
      await execAsync(`"${CAPTURE_APP}" "${tmpPath}"`, { timeout: 15000 });
      if (!existsSync(tmpPath)) throw new Error('Photo file not created');
      const buf = readFileSync(tmpPath);
      try { unlinkSync(tmpPath); } catch { /* cleanup */ }
      ctx.addPendingMedia({ type: 'image', data: buf });
      return 'Photo taken from webcam and sent.';
    } catch (e: any) {
      return `Error: Camera not available — ${e.message || 'unknown'}. Camera permission may need to be granted in System Settings > Privacy > Camera for CaptureCamera.`;
    }
  },
};

export default handler;
