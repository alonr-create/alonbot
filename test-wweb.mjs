import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/wweb-session' }),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

client.on('qr', (qr) => {
  console.log('\n✅ QR CODE GENERATED — SCAN WITH WHATSAPP:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('\n🎉 CONNECTED! WhatsApp is ready!\n');
});

client.on('auth_failure', (msg) => {
  console.error('Auth failed:', msg);
});

console.log('Starting whatsapp-web.js (Puppeteer)...');
client.initialize();
