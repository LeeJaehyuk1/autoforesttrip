import fs from 'node:fs';
import path from 'node:path';
import { config, DEBUG_DIR } from '../config.js';
import { withContext } from './browser.js';

// ⚠️ 베스트-에포트 자동 예약.
// 숲나들e 의 객실선택/예약 폼은 휴양림마다 다르고, 결제 단계는 PG(카드) 입력이 필요하다.
// 이 모듈은 [로그인 → 휴양림 예약가능 객실 페이지 진입 → 첫 가용 객실 예약 시도 → 예약/결제 페이지 도달]
// 까지만 수행하고, 비가역적인 최종 결제/확정 버튼은 절대 누르지 않는다.
// 도달한 페이지 링크를 알림으로 보내 사용자가 마지막 결제를 마치게 한다.

const LOGIN_URL = `${config.baseUrl}/com/login.do`;

// 로그인 수행. 성공 시 storageState(세션) 반환, 실패 시 throw.
export async function login(context, { loginId, loginPwd }) {
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.fill('#mmberId', loginId);
  await page.fill('#gnrlMmberPssrd', loginPwd);

  const [resp] = await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => null),
    page.evaluate(() => {
      if (typeof window.fn_goLogin === 'function') window.fn_goLogin();
      else {
        const f = document.fripPotForm;
        f.action = '/com/login';
        f.submit();
      }
    }),
  ]);

  await page.waitForTimeout(1500);
  // 로그인 성공 판정: 로그아웃 폼/마이페이지 링크 존재 또는 login.do 가 아님
  const loggedIn = await page.evaluate(() => {
    const hasLogout =
      !!document.querySelector('form[name="logoutForm"]') ||
      !!document.querySelector('a[href*="logout"]');
    const onLogin = location.pathname.includes('/com/login');
    const bodyText = document.body.innerText || '';
    const failed = /아이디 또는 비밀번호|일치하지 않|로그인 정보/.test(bodyText) && onLogin;
    return hasLogout && !onLogin && !failed;
  });

  if (!loggedIn) {
    await page.close();
    throw new Error('로그인 실패(아이디/비밀번호 확인 또는 보안 절차 필요)');
  }
  const state = await context.storageState();
  await page.close();
  return state;
}

// 자동 예약 시도.
// job: { institt_id, institt_name, region_code, begin_date, end_date, people, ... }
// creds: { loginId, loginPwd }
// 반환: { ok, stage, message, url, shotPath }
export async function attemptBooking(job, creds, { targetInsttId } = {}) {
  const trace = [];
  const insttId = targetInsttId || job.institt_id;
  return withContext(async (context) => {
    let shotPath;
    try {
      trace.push('로그인 시도');
      await login(context, creds);
      trace.push('로그인 성공');

      const page = await context.newPage();
      // 휴양림 예약가능 객실 목록으로 진입
      // fn_fsfsRsrvtPssblGoodsList(insttId) 와 동일한 목적지: 예약가능 상품 상세
      const detailUrl = buildGoodsListUrl(job, insttId);
      trace.push(`객실목록 진입: ${detailUrl}`);
      await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // 첫 번째 "예약하기"/"예약" 버튼 탐색 (가용 객실)
      const clicked = await page.evaluate(() => {
        const cands = Array.from(document.querySelectorAll('a, button'));
        const btn = cands.find((b) => {
          const t = (b.textContent || '').replace(/\s+/g, '');
          const hasReserve = /예약하기|예약신청|^예약$/.test(t);
          const disabled =
            b.disabled || b.classList.contains('disabled') || /마감|대기/.test(t);
          return hasReserve && !disabled;
        });
        if (btn) {
          btn.scrollIntoView();
          btn.click();
          return (btn.textContent || '').trim();
        }
        return null;
      });

      if (!clicked) {
        shotPath = await shot(page, 'book-noavail');
        trace.push('가용 객실 예약 버튼을 찾지 못함');
        return result(false, 'no-available-room', '예약 가능한 객실 버튼을 찾지 못했습니다. 빠르게 마감되었거나 페이지 구조가 다릅니다.', page.url(), shotPath, trace);
      }
      trace.push(`예약 버튼 클릭: "${clicked}"`);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // 약관 동의 등 자동 처리(있으면 체크) — 단, 최종 결제/확정은 누르지 않음
      await page.evaluate(() => {
        document
          .querySelectorAll('input[type=checkbox][id*=agree], input[type=checkbox][id*=Agree], input[type=checkbox][name*=agree]')
          .forEach((c) => {
            if (!c.checked) c.click();
          });
      }).catch(() => {});

      shotPath = await shot(page, 'book-stage');
      const url = page.url();
      trace.push(`예약/결제 페이지 도달: ${url}`);

      // 안전장치: 여기서 멈춘다. 최종 결제는 사용자가 진행.
      return result(
        true,
        'reservation-page',
        '예약 페이지까지 자동 진행했습니다. 알림의 링크에서 본인 인증/결제로 예약을 완료하세요(보유 시간 제한 주의).',
        url,
        shotPath,
        trace,
      );
    } catch (e) {
      trace.push(`오류: ${e.message}`);
      return result(false, 'error', e.message, undefined, shotPath, trace);
    }
  });
}

function buildGoodsListUrl(job, insttId) {
  const q = new URLSearchParams({
    hmpgId: 'FRIP',
    menuId: '001001',
    srchInsttId: insttId || '',
    srchInsttArcd: job.region_code || '',
    srchRsrvtBgDt: job.begin_date,
    srchRsrvtEdDt: job.end_date,
    srchStngNofpr: String(job.people || 2),
    srchSthngCnt: String(job.nights || 1),
    houseCampSctin: job.house_camp || '01',
  });
  return `${config.baseUrl}/rep/or/sssn/fcfsRsrvtPssblGoodsDetls.do?${q.toString()}`;
}

async function shot(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const p = path.join(DEBUG_DIR, `${tag}-${stamp}.png`);
    await page.screenshot({ path: p, fullPage: true });
    return p;
  } catch {
    return undefined;
  }
}

function result(ok, stage, message, url, shotPath, trace) {
  return { ok, stage, message, url, shotPath, trace };
}
