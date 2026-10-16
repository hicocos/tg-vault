import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { ownUserTransport } from '../services/telegramUserTransport.js';

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionFile = process.env.TELEGRAM_USER_SESSION_FILE || './data/telegram_user_session.txt';

  if (!apiId || !apiHash) {
    throw new Error('Missing TELEGRAM_API_ID / TELEGRAM_API_HASH');
  }

  const sessionDir = path.dirname(sessionFile);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string) => new Promise<string>(resolve => rl.question(question, resolve));

  const client = ownUserTransport(new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 1,
    useWSS: false,
  }), { accountId: 'cli-login' });

  try {
    await client.start({
      phoneNumber: async () => ask('Phone number: '),
      phoneCode: async () => ask('Code: '),
      password: async () => ask('2FA password (if any): '),
      onError: (err) => {
        throw err;
      },
    });

    const session = client.session.save() as unknown as string;
    fs.writeFileSync(sessionFile, session, { mode: 0o600 });
    fs.chmodSync(sessionFile, 0o600);
    console.log(`Saved user session to ${sessionFile}`);
  } finally {
    rl.close();
    await client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});