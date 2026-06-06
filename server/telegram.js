import fs from 'node:fs';
import { config } from './config.js';

const API = (method) =>
  `https://api.telegram.org/bot${config.telegram.token}/${method}`;

export function telegramEnabled() {
  return !!(config.telegram.token && config.telegram.chatIds.length);
}

export async function sendMessage(text, { html = true } = {}) {
  if (!telegramEnabled()) return { skipped: true };
  const results = [];
  for (const chatId of config.telegram.chatIds) {
    try {
      const res = await fetch(API('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: html ? 'HTML' : undefined,
          disable_web_page_preview: false,
        }),
      });
      results.push(await res.json());
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  return results;
}

export async function sendPhoto(filePath, caption = '') {
  if (!telegramEnabled() || !filePath || !fs.existsSync(filePath)) return { skipped: true };
  const results = [];
  for (const chatId of config.telegram.chatIds) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      if (caption) form.append('caption', caption.slice(0, 1024));
      const buf = fs.readFileSync(filePath);
      form.append('photo', new Blob([buf]), 'shot.png');
      const res = await fetch(API('sendPhoto'), { method: 'POST', body: form });
      results.push(await res.json());
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  return results;
}

// 봇 토큰/챗ID 점검용
export async function testTelegram() {
  if (!config.telegram.token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN 미설정' };
  if (!config.telegram.chatIds.length) return { ok: false, error: 'TELEGRAM_CHAT_ID 미설정' };
  const r = await sendMessage('✅ 숲나들e 모니터 텔레그램 연결 테스트');
  return { ok: true, detail: r };
}
