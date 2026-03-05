import express from 'express';
import { config } from '../utils/config.js';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

export function startServer() {
  app.listen(config.port, () => {
    console.log(`[Server] Health check: http://localhost:${config.port}/health`);
  });
}
