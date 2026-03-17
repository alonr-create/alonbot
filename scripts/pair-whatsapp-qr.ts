import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { mkdirSync } from 'fs';
import qrcode from 'qrcode-terminal';

const SESSION_DIR = './data/whatsapp-session';
mkdirSync(SESSION_DIR, { recursive: true });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const sock = makeWASocket({
    auth: state,
    browser: ['AlonBot', 'Chrome', '22.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWhatsApp > Linked Devices > Link a Device > Scan QR\n');
    }

    if (connection === 'open') {
      console.log('\n✅ CONNECTED! WhatsApp is paired.');
      setTimeout(() => process.exit(0), 3000);
    }

    if (connection === 'close') {
      console.log('Reconnecting...');
    }
  });

  setTimeout(() => { console.log('Timeout.'); process.exit(1); }, 180000);
}

main().catch(console.error);
