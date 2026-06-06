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
  // 한국 IP 프록시(해외 호스팅에서 숲나들e 접속 차단 우회용). 예: http://1.2.3.4:8080
  proxy: process.env.PROXY_SERVER
    ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME || undefined,
        password: process.env.PROXY_PASSWORD || undefined,
      }
    : null,
};

// 부팅 진단: 가장 먼저 평가되는 모듈이므로 여기서 전역 오류 핸들러를 등록한다.
// (이후 import 단계에서 무엇이 죽는지 로그로 확실히 남기기 위함)
process.on('uncaughtException', (e) => {
  console.error('[FATAL uncaughtException]', e?.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[FATAL unhandledRejection]', e?.stack || e);
});
console.log(
  `[boot] config 로드됨 · PORT=${config.port} · DATA_DIR=${DATA_DIR} · HEADLESS=${config.headless}`,
);

export default config;
