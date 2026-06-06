'use strict';

// ---------------- API ----------------
const api = {
  async get(url) {
    const r = await fetch(url);
    if (r.status === 401) throw { auth: true };
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(url, method, body) {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw { auth: true };
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

const $ = (id) => document.getElementById(id);
const state = { regions: [], jobs: [], creds: [], soundOn: true };

// ---------------- 초기화 ----------------
async function init() {
  const status = await api.get('/api/status').catch(() => ({}));
  if (status.authRequired && !status.authed) {
    showLogin();
    return;
  }
  setTgBadge(status.telegram);
  await Promise.all([loadRegions(), loadJobs(), loadCreds()]);
  connectSSE();
  bindUI();
}

function showLogin() {
  $('loginOverlay').classList.remove('hidden');
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.send('/api/login', 'POST', { password: $('loginPw').value });
      location.reload();
    } catch (err) {
      $('loginErr').textContent = err.message || '로그인 실패';
    }
  };
}

// ---------------- 데이터 로드 ----------------
async function loadRegions() {
  try {
    state.regions = await api.get('/api/meta/regions');
    const sel = $('f_region');
    sel.innerHTML = '<option value="">지역 선택</option>' +
      state.regions.map((r) => `<option value="${r.code}">${r.name}</option>`).join('');
  } catch (e) {
    toast('error', '지역 로드 실패', e.message);
  }
}

async function loadInstitutions(region, selectedId) {
  const sel = $('f_institt');
  sel.innerHTML = '<option value="">불러오는 중…</option>';
  try {
    const list = await api.get('/api/meta/institutions?region=' + encodeURIComponent(region));
    sel.innerHTML = '<option value="">전체 (지역 내 모두)</option>' +
      list.map((i) => `<option value="${i.code}" data-name="${esc(i.name)}">${i.type ? '[' + i.type + ']' : ''}${esc(i.name)}</option>`).join('');
    if (selectedId) sel.value = selectedId;
  } catch (e) {
    sel.innerHTML = '<option value="">전체</option>';
  }
}

async function loadJobs() {
  state.jobs = await api.get('/api/jobs');
  renderJobs();
}

async function loadCreds() {
  state.creds = await api.get('/api/credentials');
  renderCreds();
  const sel = $('f_credential');
  sel.innerHTML = state.creds.length
    ? state.creds.map((c) => `<option value="${c.id}">${esc(c.label)} (${esc(c.login_id)})</option>`).join('')
    : '<option value="">먼저 로그인 정보를 추가하세요</option>';
}

// ---------------- 렌더링 ----------------
function renderJobs() {
  const wrap = $('jobs');
  $('emptyJobs').classList.toggle('hidden', state.jobs.length > 0);
  wrap.innerHTML = state.jobs.map(jobCard).join('');
  for (const job of state.jobs) bindJobCard(job.id);
}

function jobCard(j) {
  const st = j.status || 'idle';
  const stLabel = { idle: '대기', running: '검사중', found: '빈자리!', error: '오류', stopped: '중지됨' }[st] || st;
  const cls = j.enabled ? st : 'stopped';
  let avails = [];
  try { avails = JSON.parse(j.last_results || '[]'); } catch {}
  const availHtml = avails.length
    ? `<ul class="avail-list">${avails.slice(0, 12).map((a) => `<li>${esc(a.title)} · ${a.remain ?? '?'}</li>`).join('')}</ul>`
    : '';
  const target = j.institt_name ? esc(j.institt_name) : esc(j.region_name || '지역 전체');
  return `
  <div class="job ${cls}" data-id="${j.id}">
    <div class="job-top">
      <div class="job-name">${esc(j.name)}</div>
      <span class="job-status st-${j.enabled ? st : 'stopped'}">${j.enabled ? stLabel : '중지됨'}</span>
    </div>
    <div class="job-meta">
      📍 <b>${target}</b> · ${j.house_camp === '02' ? '야영' : '휴양'}<br/>
      📅 <b>${fmtDate(j.begin_date)} ~ ${fmtDate(j.end_date)}</b> · 👤 ${j.people}명<br/>
      ⏱ ${j.interval_min}분 간격 ${j.keyword ? `· 🔎 "${esc(j.keyword)}"` : ''}
      ${j.auto_book ? '<span class="tag auto">자동예약</span>' : ''}
    </div>
    <div class="job-msg">${esc(j.last_message || '아직 검사 전')}</div>
    ${availHtml}
    <div class="job-actions">
      <button class="btn primary sm" data-act="run">지금 검사</button>
      <button class="btn ghost sm" data-act="toggle">${j.enabled ? '⏸ 정지' : '▶ 시작'}</button>
      <button class="btn ghost sm" data-act="edit">편집</button>
      <button class="btn danger sm" data-act="del">삭제</button>
    </div>
  </div>`;
}

function bindJobCard(id) {
  const el = document.querySelector(`.job[data-id="${id}"]`);
  if (!el) return;
  el.querySelector('[data-act="run"]').onclick = async () => {
    try { await api.send(`/api/jobs/${id}/run`, 'POST'); toast('', '검사 시작', ''); } catch (e) { toast('error', '실패', e.message); }
  };
  el.querySelector('[data-act="toggle"]').onclick = async () => {
    try { await api.send(`/api/jobs/${id}/toggle`, 'POST'); await loadJobs(); } catch (e) { toast('error', '실패', e.message); }
  };
  el.querySelector('[data-act="edit"]').onclick = () => openJobModal(state.jobs.find((j) => j.id === id));
  el.querySelector('[data-act="del"]').onclick = async () => {
    if (!confirm('이 모니터를 삭제할까요?')) return;
    try { await api.send(`/api/jobs/${id}`, 'DELETE'); await loadJobs(); } catch (e) { toast('error', '실패', e.message); }
  };
}

function renderCreds() {
  $('credList').innerHTML = state.creds.length
    ? state.creds.map((c) => `<li><span>🔑 ${esc(c.label)} <span class="muted">(${esc(c.login_id)})</span></span>
       <button class="btn danger sm" data-cred="${c.id}">삭제</button></li>`).join('')
    : '<li class="muted sm">등록된 로그인 정보가 없습니다.</li>';
  document.querySelectorAll('[data-cred]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('로그인 정보를 삭제할까요?')) return;
      await api.send('/api/credentials/' + b.dataset.cred, 'DELETE');
      await loadCreds();
    };
  });
}

// ---------------- 모달 ----------------
function openJobModal(job) {
  $('jobForm').reset();
  $('jobErr').textContent = '';
  $('jobModalTitle').textContent = job ? '모니터 편집' : '새 모니터';
  $('jobId').value = job ? job.id : '';
  // 기본값
  const today = new Date();
  const d2 = new Date(today); d2.setDate(d2.getDate() + 1);
  $('f_begin').value = job ? toInputDate(job.begin_date) : today.toISOString().slice(0, 10);
  $('f_end').value = job ? toInputDate(job.end_date) : d2.toISOString().slice(0, 10);

  if (job) {
    $('f_name').value = job.name;
    $('f_region').value = job.region_code || '';
    $('f_houseCamp').value = job.house_camp || '01';
    $('f_people').value = job.people || 2;
    $('f_keyword').value = job.keyword || '';
    $('f_autobook').checked = !!job.auto_book;
    setInterval_(job.interval_min);
    if (job.region_code) loadInstitutions(job.region_code, job.institt_id);
  } else {
    setInterval_(5);
    $('f_institt').innerHTML = '<option value="">전체</option>';
  }
  $('f_enabled').checked = job ? !!job.enabled : true;
  toggleAutobook();
  $('jobModal').classList.remove('hidden');
}

function closeModals() {
  document.querySelectorAll('.overlay').forEach((o) => {
    if (o.id !== 'loginOverlay') o.classList.add('hidden');
  });
}

function setInterval_(v) {
  let matched = false;
  document.querySelectorAll('#f_intervalSeg button').forEach((b) => {
    const on = Number(b.dataset.v) === Number(v);
    b.classList.toggle('on', on);
    if (on) matched = true;
  });
  $('f_intervalCustom').value = matched ? '' : v;
}
function getInterval() {
  const custom = Number($('f_intervalCustom').value);
  if (custom >= 1) return custom;
  const on = document.querySelector('#f_intervalSeg button.on');
  return on ? Number(on.dataset.v) : 5;
}
function toggleAutobook() {
  $('autobookOpts').classList.toggle('hidden', !$('f_autobook').checked);
}

async function submitJob(e) {
  e.preventDefault();
  const id = $('jobId').value;
  const instSel = $('f_institt');
  const regSel = $('f_region');
  const body = {
    name: $('f_name').value,
    region_code: regSel.value,
    region_name: regSel.options[regSel.selectedIndex]?.text?.trim() || '',
    institt_id: instSel.value,
    institt_name: instSel.value ? (instSel.options[instSel.selectedIndex]?.dataset.name || '') : '',
    house_camp: $('f_houseCamp').value,
    people: Number($('f_people').value) || 2,
    begin_date: $('f_begin').value.replace(/-/g, ''),
    end_date: $('f_end').value.replace(/-/g, ''),
    keyword: $('f_keyword').value,
    interval_min: getInterval(),
    auto_book: $('f_autobook').checked,
    credential_id: $('f_autobook').checked ? Number($('f_credential').value) || null : null,
    enabled: $('f_enabled').checked,
  };
  try {
    if (id) await api.send('/api/jobs/' + id, 'PUT', body);
    else await api.send('/api/jobs', 'POST', body);
    closeModals();
    await loadJobs();
  } catch (err) {
    $('jobErr').textContent = err.message;
  }
}

// ---------------- 자격증명 모달 ----------------
function openCredModal() {
  $('credForm').reset();
  $('credErr').textContent = '';
  $('credModal').classList.remove('hidden');
}
async function submitCred(e) {
  e.preventDefault();
  try {
    await api.send('/api/credentials', 'POST', {
      label: $('c_label').value,
      login_id: $('c_id').value,
      password: $('c_pw').value,
    });
    closeModals();
    await loadCreds();
  } catch (err) {
    $('credErr').textContent = err.message;
  }
}

// ---------------- SSE ----------------
function connectSSE() {
  const es = new EventSource('/api/events/stream');
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'job') updateJobInPlace(msg.job);
    else if (msg.type === 'log') prependLog(msg.event);
    else if (msg.type === 'toast') {
      toast(msg.toast.level, msg.toast.title, msg.toast.message);
      if (msg.toast.level === 'success') beep();
    }
  };
  es.onerror = () => {/* 브라우저가 자동 재연결 */};
}

function updateJobInPlace(job) {
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) state.jobs[idx] = job;
  else state.jobs.unshift(job);
  renderJobs();
}

function prependLog(ev) {
  if (!ev) return;
  const ul = $('logFeed');
  const li = document.createElement('li');
  const cls = ev.level === 'found' ? 'log-found' : ev.level === 'error' ? 'log-error' : ev.level === 'book' ? 'log-book' : '';
  const t = (ev.ts || '').slice(11, 19) || new Date().toTimeString().slice(0, 8);
  li.innerHTML = `<span class="log-time">${t}</span><span class="${cls}">${esc(ev.message || '')}</span>`;
  ul.prepend(li);
  while (ul.children.length > 80) ul.lastChild.remove();
}

// ---------------- UI 바인딩 ----------------
function bindUI() {
  $('btnAdd').onclick = () => openJobModal(null);
  $('btnRefresh').onclick = loadJobs;
  $('btnClearLog').onclick = () => ($('logFeed').innerHTML = '');
  $('btnAddCred').onclick = openCredModal;
  $('jobForm').onsubmit = submitJob;
  $('credForm').onsubmit = submitCred;
  $('f_region').onchange = (e) => loadInstitutions(e.target.value);
  $('f_autobook').onchange = toggleAutobook;
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModals));
  document.querySelectorAll('.overlay').forEach((o) => {
    o.addEventListener('click', (e) => { if (e.target === o && o.id !== 'loginOverlay') closeModals(); });
  });
  $('f_intervalSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { setInterval_(Number(b.dataset.v)); };
  });
  $('f_intervalCustom').oninput = () => {
    if (Number($('f_intervalCustom').value) >= 1)
      document.querySelectorAll('#f_intervalSeg button').forEach((b) => b.classList.remove('on'));
  };
  $('btnTgTest').onclick = async () => {
    try {
      const r = await api.send('/api/telegram/test', 'POST');
      toast(r.ok ? 'success' : 'error', r.ok ? '전송됨' : '실패', r.error || '텔레그램 확인하세요');
    } catch (e) { toast('error', '실패', e.message); }
  };
  $('soundToggle').onclick = () => {
    state.soundOn = !state.soundOn;
    $('soundToggle').textContent = state.soundOn ? '🔔' : '🔕';
    if (state.soundOn) beep();
  };
}

function setTgBadge(on) {
  const b = $('tgBadge');
  b.textContent = on ? '텔레그램 ✓' : '텔레그램 미설정';
  b.classList.add(on ? 'ok' : 'off');
}

// ---------------- 유틸 ----------------
function esc(s) { return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function fmtDate(s) { return s && s.length === 8 ? `${s.slice(4, 6)}.${s.slice(6, 8)}` : (s || ''); }
function toInputDate(s) { return s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : ''; }

function toast(level, title, message) {
  const el = document.createElement('div');
  el.className = 'toast ' + (level || '');
  el.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${esc(message || '')}`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

let audioCtx;
function beep() {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1100, 1320];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    });
  } catch {}
}

init();
