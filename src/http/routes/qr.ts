import { Router } from 'express';
import { getCurrentQR, getConnectionStatus } from '../../whatsapp/qr.js';

export const qrRouter = Router();

qrRouter.get('/qr', (_req, res) => {
  const connected = getConnectionStatus() === 'connected';
  const qr = getCurrentQR();

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AlonBot - WhatsApp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #eee;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 1rem;
      color: #fff;
    }
    .status {
      font-size: 1.2rem;
      margin-bottom: 1.5rem;
      padding: 0.5rem 1.5rem;
      border-radius: 8px;
      display: inline-block;
    }
    .status.connected {
      background: #1b5e20;
      color: #a5d6a7;
    }
    .status.waiting {
      background: #f57f17;
      color: #fff8e1;
    }
    .qr-img {
      max-width: 300px;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
    }
    .connected-msg {
      font-size: 3rem;
      margin: 1rem 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AlonBot - WhatsApp</h1>
    <div id="status" class="status ${connected ? 'connected' : 'waiting'}">
      ${connected ? 'מחובר' : 'ממתין ל-QR'}
    </div>
    <div id="qr-container">
      ${connected
        ? '<div class="connected-msg">&#x2705;</div>'
        : qr
          ? `<img class="qr-img" src="${qr}" alt="QR Code" />`
          : '<p>ממתין לקוד QR...</p>'}
    </div>
  </div>
  <script>
    async function poll() {
      try {
        const res = await fetch('/api/qr-status');
        const data = await res.json();
        const statusEl = document.getElementById('status');
        const qrEl = document.getElementById('qr-container');

        if (data.connected) {
          statusEl.className = 'status connected';
          statusEl.textContent = 'מחובר';
          qrEl.innerHTML = '<div class="connected-msg">&#x2705;</div>';
        } else {
          statusEl.className = 'status waiting';
          statusEl.textContent = 'ממתין ל-QR';
          if (data.qr) {
            qrEl.innerHTML = '<img class="qr-img" src="' + data.qr + '" alt="QR Code" />';
          } else {
            qrEl.innerHTML = '<p>ממתין לקוד QR...</p>';
          }
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    }
    setInterval(poll, 2000);
  </script>
</body>
</html>`;

  res.type('html').send(html);
});

qrRouter.get('/api/qr-status', (_req, res) => {
  const status = getConnectionStatus();
  res.json({
    connected: status === 'connected',
    qr: getCurrentQR(),
    status,
  });
});
