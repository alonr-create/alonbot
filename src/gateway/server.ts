import express from 'express';
import { config } from '../utils/config.js';
import { executeTool } from '../agent/tools.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: config.mode, uptime: process.uptime(), localConnected: !!config.localApiUrl });
});

// Cloud mode: allow local Mac to register its tunnel URL
if (config.mode === 'cloud') {
  app.post('/api/register-local', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    // Update config in memory (no restart needed)
    (config as any).localApiUrl = url;
    console.log(`[Server] Local Mac registered: ${url}`);
    res.json({ ok: true, registered: url });
  });
}

// Local mode: expose tools as API for cloud proxy
if (config.mode === 'local') {
  app.post('/api/tool', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, input } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Missing tool name' });
      return;
    }

    try {
      const result = await executeTool(name, input || {});
      // Check for pending media (screenshot, etc.)
      const { collectMedia } = await import('../agent/tools.js');
      const media = collectMedia();
      res.json({ result, media: media.map(m => ({ type: m.type, data: m.data.toString('base64') })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

export function startServer() {
  app.listen(config.port, () => {
    console.log(`[Server] Health check: http://localhost:${config.port}/health`);
    if (config.mode === 'local') {
      console.log(`[Server] Tool API: http://localhost:${config.port}/api/tool`);
    }
  });
}
