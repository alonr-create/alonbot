import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { mkdirSync } from 'fs';

const SESSION_DIR = './data/whatsapp-session';
mkdirSync(SESSION_DIR, { recursive: true });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ['AlonBot', 'Chrome', '22.0'] });

  sock.ev.on('creds.update', saveCreds);

  let paired = false;
  let codeRequested = false;

  async function requestCode() {
    if (codeRequested) return;
    codeRequested = true;
    try {
      const code = await sock.requestPairingCode('972546300783');
      console.log('');
      console.log('========================================');
      console.log(`  PAIRING CODE: ${code}`);
      console.log('========================================');
      console.log('');
      console.log('WhatsApp > Linked Devices > Link a Device');
      console.log('> Link with phone number > Enter code above');
    } catch (e: any) {
      console.error('Pairing error:', e.message);
      codeRequested = false; // Allow retry
    }
  }

  sock.ev.on('connection.update', (update) => {
    console.log('Connection:', update.connection);

    if (update.connection === 'connecting' && !paired) {
      // Request pairing code immediately when connecting
      setTimeout(requestCode, 1500);
    }

    if (update.connection === 'open') {
      paired = true;
      console.log('✅ CONNECTED! WhatsApp is paired.');
      setTimeout(() => process.exit(0), 2000);
    }
  });

  // Keep alive for 2 minutes
  setTimeout(() => { console.log('Timeout — no pairing.'); process.exit(1); }, 120000);
}

main().catch(console.error);
