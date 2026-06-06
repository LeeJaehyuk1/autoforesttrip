import express from 'express';
import crypto from 'node:crypto';
import { config, PUBLIC_DIR } from './config.js';
import { jobsRepo, credsRepo, eventsRepo } from './db.js';
import { encrypt } from './crypto.js';
import { fetchRegions, fetchInstitutions } from './foresttrip/client.js';
import { startScheduler, scheduleJob, unscheduleJob, runNow } from './scheduler.js';
import { bus } from './bus.js';
import { testTelegram, telegramEnabled } from './telegram.js';
import { closeBrowser } from './foresttrip/browser.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---------------- 간단 비밀번호 인증(선택) ----------------
const AUTH_TOKEN = config.appPassword
  ? crypto.createHmac('sha256', config.encryptionKey).update(config.appPassword).digest('hex')
  : null;

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  if (!AUTH_TOKEN) return true;
  return parseCookies(req).aft_auth === AUTH_TOKEN;
}

app.post('/api/login', (req, res) => {
  if (!AUTH_TOKEN) return res.json({ ok: true });
  if (req.body?.password && req.body.password === config.appPassword) {
    res.setHeader(
      'Set-Cookie',
      `aft_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
});

app.get('/api/status', (req, res) => {
  res.json({
    authRequired: !!AUTH_TOKEN,
    authed: isAuthed(req),
    telegram: telegramEnabled(),
    headless: config.headless,
  });
});

// /api 가드(상태/로그인 제외)
app.use('/api', (req, res, next) => {
  if (req.path === '/status' || req.path === '/login') return next();
  if (!isAuthed(req)) return res.status(401).json({ error: '인증이 필요합니다.' });
  next();
});

// ---------------- 메타데이터 ----------------
let regionCache = null;
const instCache = new Map();

app.get('/api/meta/regions', async (req, res) => {
  try {
    if (!regionCache) regionCache = await fetchRegions();
    res.json(regionCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/meta/institutions', async (req, res) => {
  const region = String(req.query.region || '');
  if (!region) return res.status(400).json({ error: 'region 필요' });
  try {
    if (!instCache.has(region)) instCache.set(region, await fetchInstitutions(region));
    res.json(instCache.get(region));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- 잡 ----------------
function computeNights(begin, end) {
  try {
    const b = new Date(`${begin.slice(0, 4)}-${begin.slice(4, 6)}-${begin.slice(6, 8)}`);
    const e = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`);
    const n = Math.round((e - b) / 86400000);
    return n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

function sanitizeJob(body) {
  const begin = String(body.begin_date || '').replace(/\D/g, '');
  const end = String(body.end_date || '').replace(/\D/g, '');
  return {
    name: String(body.name || '').trim() || '이름없는 모니터',
    region_code: String(body.region_code || ''),
    region_name: String(body.region_name || ''),
    institt_id: String(body.institt_id || ''),
    institt_name: String(body.institt_name || ''),
    begin_date: begin,
    end_date: end,
    nights: Number(body.nights) || computeNights(begin, end),
    people: Math.max(1, Number(body.people) || 2),
    house_camp: body.house_camp === '02' ? '02' : '01',
    keyword: String(body.keyword || '').trim(),
    interval_min: Math.max(1, Number(body.interval_min) || 5),
    enabled: body.enabled === false ? 0 : 1,
    auto_book: body.auto_book ? 1 : 0,
    credential_id: body.credential_id ? Number(body.credential_id) : null,
  };
}

function validateJob(j) {
  if (!j.region_code) return '지역을 선택하세요.';
  if (!/^\d{8}$/.test(j.begin_date)) return '입실일이 올바르지 않습니다.';
  if (!/^\d{8}$/.test(j.end_date)) return '퇴실일이 올바르지 않습니다.';
  if (j.end_date <= j.begin_date) return '퇴실일은 입실일 이후여야 합니다.';
  if (j.auto_book && !j.credential_id) return '자동예약을 켜려면 로그인 정보를 연결하세요.';
  return null;
}

app.get('/api/jobs', (req, res) => res.json(jobsRepo.list()));

app.post('/api/jobs', (req, res) => {
  const j = sanitizeJob(req.body);
  const err = validateJob(j);
  if (err) return res.status(400).json({ error: err });
  const id = jobsRepo.create(j);
  if (j.enabled) scheduleJob(id, true);
  res.json(jobsRepo.get(id));
});

app.put('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!jobsRepo.get(id)) return res.status(404).json({ error: '없는 잡' });
  const j = sanitizeJob(req.body);
  const err = validateJob(j);
  if (err) return res.status(400).json({ error: err });
  jobsRepo.update(id, j);
  jobsRepo.setEnabled(id, j.enabled);
  if (j.enabled) scheduleJob(id, true);
  else unscheduleJob(id);
  res.json(jobsRepo.get(id));
});

app.post('/api/jobs/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const job = jobsRepo.get(id);
  if (!job) return res.status(404).json({ error: '없는 잡' });
  const enabled = !job.enabled;
  jobsRepo.setEnabled(id, enabled);
  if (enabled) scheduleJob(id, true);
  else unscheduleJob(id);
  res.json(jobsRepo.get(id));
});

app.post('/api/jobs/:id/run', async (req, res) => {
  const id = Number(req.params.id);
  if (!jobsRepo.get(id)) return res.status(404).json({ error: '없는 잡' });
  runNow(id); // 비동기 실행, 결과는 SSE 로
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  unscheduleJob(id);
  jobsRepo.remove(id);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/events', (req, res) => {
  res.json(eventsRepo.listByJob(Number(req.params.id), 80));
});

// ---------------- 자격증명 ----------------
app.get('/api/credentials', (req, res) => res.json(credsRepo.list()));

app.post('/api/credentials', (req, res) => {
  const { label, login_id, password } = req.body || {};
  if (!login_id || !password) return res.status(400).json({ error: '아이디/비밀번호 필요' });
  const id = credsRepo.create({
    label: String(label || login_id),
    login_id: String(login_id),
    pw_enc: encrypt(String(password)),
  });
  res.json({ id, label: label || login_id, login_id });
});

app.delete('/api/credentials/:id', (req, res) => {
  credsRepo.remove(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------- 텔레그램 테스트 ----------------
app.post('/api/telegram/test', async (req, res) => {
  res.json(await testTelegram());
});

// ---------------- SSE ----------------
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const onEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('event', onEvent);
  const hb = setInterval(() => res.write(': hb\n\n'), 25000);
  req.on('close', () => {
    clearInterval(hb);
    bus.off('event', onEvent);
  });
});

// ---------------- 정적 파일 ----------------
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));

console.log(`[boot] listen 시도: 0.0.0.0:${config.port}`);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n🌲 숲나들e 모니터 실행 중 (0.0.0.0:${config.port})`);
  console.log(`   텔레그램: ${telegramEnabled() ? '연결됨' : '미설정'} · 인증: ${AUTH_TOKEN ? '비밀번호' : '없음'}`);
  try {
    startScheduler();
  } catch (e) {
    console.error('[scheduler] 시작 오류', e?.stack || e);
  }
});
server.on('error', (e) => {
  console.error('[FATAL listen error]', e?.stack || e);
});

async function shutdown() {
  console.log('\n종료 중…');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
