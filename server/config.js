import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DEBUG_DIR = path.join(ROOT, 'debug');
export const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true' || v === '1';
}

// 암호화 키: env > data/secret.key > 신규 생성
function resolveEncryptionKey() {
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim()) {
    return process.env.ENCRYPTION_KEY.trim();
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  appPassword: process.env.APP_PASSWORD || '',
  encryptionKey: resolveEncryptionKey(),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatIds: (process.env.TELEGRAM_CHAT_ID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  headless: bool(process.env.HEADLESS, true),
  debugDump: bool(process.env.DEBUG_DUMP, false),
  baseUrl: 'https://www.foresttrip.go.kr',
};

export default config;
