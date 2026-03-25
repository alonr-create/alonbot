import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import http from 'http';

let currentQR = null;
let isConnected = false;

const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (isConnected) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1 style="color:green;font-family:sans-serif;text-align:center;margin-top:100px">✅ מחובר!</h1>');
    } else if (currentQR) {
      const img = await qrcode.toDataURL(currentQR);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
        <img src="${img}" style="width:300px;height:300px">
        <script>setTimeout(()=>location.reload(),5000)</script>
      </body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;text-align:center;margin-top:100px">טוען... רענן בעוד שניה</h2><script>setTimeout(()=>location.reload(),2000)</script>');
    }
  }
});

server.listen(3001, () => console.log('QR server at http://localhost:3001/qr'));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/wweb-session' }),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

client.on('qr', (qr) => {
  currentQR = qr;
  console.log('✅ QR ready at http://localhost:3001/qr');
});

client.on('ready', () => {
  isConnected = true;
  console.log('🎉 CONNECTED!');
});

client.initialize();
