import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

console.log('Starting WhatsApp Web.js pairing...');
console.log('Waiting for QR code...\n');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/whatsapp-wwjs-session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('📱 Scan this QR code with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
  console.log('\nWhatsApp > Linked Devices > Link a Device > Scan QR');
});

client.on('ready', () => {
  console.log('\n✅ CONNECTED! WhatsApp is paired.');
  console.log('Session saved. You can close this now.\n');
  setTimeout(() => process.exit(0), 3000);
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  process.exit(1);
});

client.initialize();

setTimeout(() => { console.log('Timeout.'); process.exit(1); }, 180000);
