import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { createServer } from 'http';
import QRCode from 'qrcode';

let currentQR = '';
let status = 'waiting';

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/qr.png') && currentQR) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    const buf = await QRCode.toBuffer(currentQR, { width: 400 });
    res.end(buf);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  let body: string;
  if (status === 'connected') {
    body = '<p class="done">✅ מחובר בהצלחה! אפשר לסגור.</p>';
  } else if (currentQR) {
    body = `<img src="/qr.png?t=${Date.now()}" width="400"><br>
       <p>📱 WhatsApp > הגדרות > מכשירים מקושרים > קשר מכשיר</p>
       <p>סרוק את ה-QR הזה</p>`;
  } else {
    body = '<p class="wait">⏳ טוען... הדף יתעדכן אוטומטית</p>';
  }

  res.end(`<!DOCTYPE html>
<html dir="rtl"><head><title>WhatsApp QR</title>
<meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui;text-align:center;padding:40px;background:#111;color:#fff}
img{border-radius:12px;margin:20px}h1{color:#25D366}.done{color:#25D366;font-size:2em}
.wait{color:#888;font-size:1.2em}</style>
</head><body>
<h1>🔗 קישור WhatsApp לבוט</h1>
${body}
</body></html>`);
});

server.listen(3701, () => {
  console.log('🌐 Open: http://localhost:3701');
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/whatsapp-wwjs-session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/niconiahi/niconiahi.github.io/main/niconiahi/niconiahi-web-versions/2.3000.1020019991.html'
  }
});

client.on('qr', (qr: string) => {
  currentQR = qr;
  console.log('QR ready — scan from browser');
});

client.on('ready', () => {
  status = 'connected';
  console.log('✅ CONNECTED! WhatsApp paired.');
  setTimeout(() => { server.close(); process.exit(0); }, 5000);
});

client.on('auth_failure', (msg: string) => {
  console.error('Auth failed:', msg);
  process.exit(1);
});

client.initialize();
console.log('Initializing (Puppeteer loading, ~20s)...');

setTimeout(() => { console.log('Timeout.'); process.exit(1); }, 180000);
