import { readFileSync, unlinkSync, existsSync } from 'fs';
import { execAsync } from '../../utils/shell.js';
import type { ToolHandler } from '../types.js';

const CAPTURE_APP = '/Users/oakhome/קלוד עבודות/alonbot/scripts/CaptureCamera.app';
const CAPTURE_BIN = CAPTURE_APP + '/Contents/MacOS/CaptureCamera';

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      // Wait a bit more to make sure file is fully written
      await new Promise(r => setTimeout(r, 300));
      if (existsSync(path)) return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function capturePhoto(tmpPath: string): Promise<Buffer> {
  // Kill any leftover CaptureCamera process from previous attempts
  try { await execAsync('pkill -f CaptureCamera', { timeout: 3000 }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 500));

  // Try direct binary first (more reliable from LaunchAgent context)
  try {
    await execAsync(`"${CAPTURE_BIN}" "${tmpPath}"`, { timeout: 20000 });
    if (existsSync(tmpPath)) {
      return readFileSync(tmpPath);
    }
  } catch { /* fall through */ }

  // Fallback: launch as GUI app via 'open'
  try {
    await execAsync(
      `open -W -a "${CAPTURE_APP}" --args "${tmpPath}"`,
      { timeout: 20000 }
    );
    // open -W may return before file is written, wait for it
    if (await waitForFile(tmpPath, 5000)) {
      return readFileSync(tmpPath);
    }
  } catch { /* fall through */ }

  throw new Error('Camera capture failed with both methods');
}

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
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const buf = await capturePhoto(tmpPath);
        try { unlinkSync(tmpPath); } catch { /* cleanup */ }
        if (buf.length < 1000) {
          // Too small = probably corrupt/empty
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          return 'Error: Camera returned an empty image. The camera may be in use by another app.';
        }
        ctx.addPendingMedia({ type: 'image', data: buf });
        return 'Photo taken from webcam and sent.';
      } catch {
        try { unlinkSync(tmpPath); } catch { /* cleanup */ }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      }
    }

    return 'Error: Camera not available after 3 attempts. Check System Settings > Privacy & Security > Camera permissions for CaptureCamera and Terminal.';
  },
};

export default handler;
