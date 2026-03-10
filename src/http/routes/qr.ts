import { Router } from 'express';
import { getCurrentQR, getConnectionStatus, getPairingCode } from '../../whatsapp/qr.js';

export const qrRouter = Router();

qrRouter.get('/qr', (_req, res) => {
  const connected = getConnectionStatus() === 'connected';
  const qr = getCurrentQR();
  const pairingCode = getPairingCode();

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
    .container { text-align: center; padding: 2rem; max-width: 500px; }
    h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #fff; }
    .status {
      font-size: 1.2rem;
      margin-bottom: 1.5rem;
      padding: 0.5rem 1.5rem;
      border-radius: 8px;
      display: inline-block;
    }
    .status.connected { background: #1b5e20; color: #a5d6a7; }
    .status.waiting { background: #f57f17; color: #fff8e1; }
    .connected-msg { font-size: 3rem; margin: 1rem 0; }
    .qr-img {
      max-width: 280px;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
      margin: 1rem auto;
    }
    .divider {
      color: #666;
      margin: 1.5rem 0;
      font-size: 0.9rem;
    }
    .pairing-code {
      font-size: 2.5rem;
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      letter-spacing: 0.3em;
      background: #16213e;
      border: 2px solid #0f3460;
      border-radius: 12px;
      padding: 1rem 1.5rem;
      margin: 1rem auto;
      display: inline-block;
      color: #25d366;
    }
    .instructions {
      color: #aaa;
      font-size: 0.85rem;
      margin-top: 0.5rem;
      line-height: 1.6;
    }
    .instructions b { color: #fff; }
    .method-label {
      color: #888;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AlonBot - WhatsApp</h1>
    <div id="status" class="status ${connected ? 'connected' : 'waiting'}">
      ${connected ? 'מחובר' : 'ממתין לחיבור'}
    </div>
    <div id="content">
      ${connected
        ? '<div class="connected-msg">&#x2705;</div>'
        : `
          ${qr ? `
            <div class="method-label">אפשרות 1: סרוק QR</div>
            <img class="qr-img" src="${qr}" alt="QR Code" />
          ` : ''}
          ${qr && pairingCode ? '<div class="divider">— או —</div>' : ''}
          ${pairingCode ? `
            <div class="method-label">אפשרות 2: הזן קוד</div>
            <div class="pairing-code">${pairingCode}</div>
            <div class="instructions">
              הגדרות > מכשירים מקושרים > קשר מכשיר > "קישור עם מספר טלפון"
            </div>
          ` : ''}
          ${!qr && !pairingCode ? '<p>מחכה לחיבור...</p>' : ''}
        `}
    </div>
  </div>
  <script>
    async function poll() {
      try {
        const res = await fetch('/api/qr-status');
        const data = await res.json();
        const statusEl = document.getElementById('status');
        const contentEl = document.getElementById('content');

        if (data.connected) {
          statusEl.className = 'status connected';
          statusEl.textContent = 'מחובר';
          contentEl.innerHTML = '<div class="connected-msg">&#x2705;</div>';
        } else {
          statusEl.className = 'status waiting';
          statusEl.textContent = 'ממתין לחיבור';
          let html = '';
          if (data.qr) {
            html += '<div class="method-label">אפשרות 1: סרוק QR</div>';
            html += '<img class="qr-img" src="' + data.qr + '" alt="QR Code" />';
          }
          if (data.qr && data.pairingCode) {
            html += '<div class="divider">— או —</div>';
          }
          if (data.pairingCode) {
            html += '<div class="method-label">אפשרות 2: הזן קוד</div>';
            html += '<div class="pairing-code">' + data.pairingCode + '</div>';
            html += '<div class="instructions">הגדרות > מכשירים מקושרים > קשר מכשיר > "קישור עם מספר טלפון"</div>';
          }
          if (!data.qr && !data.pairingCode) {
            html = '<p>מחכה לחיבור...</p>';
          }
          contentEl.innerHTML = html;
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
    pairingCode: getPairingCode(),
    status,
  });
});
