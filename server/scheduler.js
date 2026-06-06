import { jobsRepo, eventsRepo, credsRepo } from './db.js';
import { decrypt } from './crypto.js';
import { runCheck } from './monitor.js';
import { attemptBooking } from './foresttrip/booking.js';
import { sendMessage, sendPhoto, telegramEnabled } from './telegram.js';
import { emitJobUpdate, emitLog, emitToast } from './bus.js';
import { config } from './config.js';

const timers = new Map(); // jobId -> timeout
const running = new Set(); // jobId currently executing

// 동시 실행 제한(Playwright 는 무겁다)
const MAX_CONCURRENT = 2;
let active = 0;
const waitQueue = [];
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}
function release() {
  active--;
  const next = waitQueue.shift();
  if (next) {
    active++;
    next();
  }
}

const minutes = (m) => Math.max(1, Number(m) || 5) * 60 * 1000;
const jitter = () => Math.floor(Math.random() * 5000);

export function startScheduler() {
  for (const job of jobsRepo.list()) {
    if (job.enabled) scheduleJob(job.id, true);
  }
  console.log(`[scheduler] ${timers.size}개 잡 스케줄됨`);
}

export function scheduleJob(jobId, immediate = false) {
  unscheduleJob(jobId);
  const job = jobsRepo.get(jobId);
  if (!job || !job.enabled) return;
  const delay = immediate ? 1000 + jitter() : minutes(job.interval_min) + jitter();
  timers.set(jobId, setTimeout(() => tick(jobId), delay));
}

export function unscheduleJob(jobId) {
  const t = timers.get(jobId);
  if (t) clearTimeout(t);
  timers.delete(jobId);
}

export function stopScheduler() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

// 수동 "지금 검사" — 스케줄과 별개로 1회 실행
export async function runNow(jobId) {
  return tick(jobId, { reschedule: false });
}

async function tick(jobId, { reschedule = true } = {}) {
  const job = jobsRepo.get(jobId);
  if (!job) return;
  if (!job.enabled && reschedule) return;
  if (running.has(jobId)) {
    if (reschedule) scheduleJob(jobId);
    return;
  }
  running.add(jobId);

  await acquire();
  try {
    jobsRepo.setRuntime(jobId, { status: 'running', last_message: '검사 중…' });
    emitJobUpdate(jobsRepo.get(jobId));

    const result = await runCheck(job);

    const status = result.found ? 'found' : 'idle';
    jobsRepo.setRuntime(jobId, {
      status,
      last_found: result.found ? 1 : 0,
      last_count: result.availableCount,
      last_message: result.found
        ? `빈자리 ${result.availableCount}곳 발견 (스캔 ${result.totalScanned})`
        : `빈자리 없음 (스캔 ${result.totalScanned})`,
      last_results: JSON.stringify(result.availableItems.slice(0, 30)),
    });

    eventsRepo.add({
      job_id: jobId,
      level: result.found ? 'found' : 'info',
      found: result.found ? 1 : 0,
      count: result.availableCount,
      message: result.found
        ? `빈자리 ${result.availableCount}곳: ` +
          result.availableItems.map((i) => `${i.title}(${i.remain ?? '?'})`).join(', ')
        : `빈자리 없음 (스캔 ${result.totalScanned}개)`,
    });

    emitJobUpdate(jobsRepo.get(jobId));
    emitLog(eventsRepo.listByJob(jobId, 1)[0]);

    // 새 빈자리 알림(중복 방지: signature 비교)
    const fresh = jobsRepo.get(jobId);
    if (result.found && result.signature && result.signature !== fresh.notified_sig) {
      await notifyFound(job, result);
      jobsRepo.setRuntime(jobId, { notified_sig: result.signature });

      if (job.auto_book) {
        await tryAutoBook(job, result);
      }
    } else if (!result.found) {
      // 다시 빈자리 나면 재알림되도록 시그니처 초기화
      if (fresh.notified_sig) jobsRepo.setRuntime(jobId, { notified_sig: '' });
    }
  } catch (e) {
    jobsRepo.setRuntime(jobId, { status: 'error', last_message: `오류: ${e.message}` });
    eventsRepo.add({ job_id: jobId, level: 'error', message: e.message });
    emitJobUpdate(jobsRepo.get(jobId));
    emitLog(eventsRepo.listByJob(jobId, 1)[0]);
    console.error(`[job ${jobId}] error`, e.message);
  } finally {
    release();
    running.delete(jobId);
    if (reschedule) scheduleJob(jobId);
  }
}

async function notifyFound(job, result) {
  const lines = result.availableItems
    .slice(0, 15)
    .map((i) => `• ${escapeHtml(i.title)} — 예약가능 ${i.remain ?? '?'}`)
    .join('\n');
  const text =
    `🌲 <b>빈자리 발견!</b> [${escapeHtml(job.name)}]\n` +
    `📅 ${fmtDate(job.begin_date)} ~ ${fmtDate(job.end_date)} · 👤 ${job.people}명\n` +
    `${lines}\n\n` +
    `🔗 ${config.baseUrl}/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001`;
  await sendMessage(text);
  emitToast({ level: 'success', title: '빈자리 발견', message: `${job.name}: ${result.availableCount}곳` });
}

async function tryAutoBook(job, result) {
  if (!job.credential_id) {
    await sendMessage(`⚠️ [${escapeHtml(job.name)}] 자동예약이 켜져 있으나 로그인 정보가 연결되지 않았습니다.`);
    return;
  }
  const cred = credsRepo.get(job.credential_id);
  if (!cred) return;
  const creds = { loginId: cred.login_id, loginPwd: decrypt(cred.pw_enc) };

  eventsRepo.add({ job_id: job.id, level: 'book', message: '자동예약 시도 시작' });
  emitLog(eventsRepo.listByJob(job.id, 1)[0]);

  // 가용 항목 중 instttId 가 있는 첫 번째를 대상으로
  const target = result.availableItems.find((i) => i.instttId) || result.availableItems[0];
  const r = await attemptBooking(job, creds, { targetInsttId: target?.instttId });

  eventsRepo.add({
    job_id: job.id,
    level: r.ok ? 'book' : 'error',
    message: `자동예약 [${r.stage}] ${r.message}` + (r.url ? ` ${r.url}` : ''),
    payload: { trace: r.trace },
  });
  emitLog(eventsRepo.listByJob(job.id, 1)[0]);

  const head = r.ok ? '🤖 자동예약 진행됨' : '🤖 자동예약 실패';
  await sendMessage(
    `${head} [${escapeHtml(job.name)}]\n` +
      `단계: ${escapeHtml(r.stage)}\n${escapeHtml(r.message)}` +
      (r.url ? `\n🔗 ${r.url}` : ''),
  );
  if (r.shotPath) await sendPhoto(r.shotPath, `${job.name} 예약 화면`);
}

function fmtDate(s) {
  if (!s || s.length !== 8) return s || '';
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}
function escapeHtml(s) {
  return String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

export { telegramEnabled };
