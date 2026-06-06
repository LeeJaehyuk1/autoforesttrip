import fs from 'node:fs';
import path from 'node:path';
import { config, DEBUG_DIR } from '../config.js';
import { withContext } from './browser.js';
import { parseSearchResult, domExtractor } from './parser.js';

const MAIN_URL = `${config.baseUrl}/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001`;

// --- 메타데이터: 시도(지역) 목록 ---------------------------------------
export async function fetchRegions() {
  return withContext(async (context) => {
    const page = await context.newPage();
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const list = await page.evaluate(async () => {
      const csrf = document.querySelector('[name=_csrf]')?.value || '';
      const res = await fetch(`/rep/or/selectSiDoList.do?_csrf=${csrf}`, {
        headers: { 'X-Ajax-call': 'true' },
      });
      return res.json();
    });
    return normalizeCodeList(list, ['insttArcd', 'arcd', 'code', 'detailCode'], ['arnm', 'codeNm', 'name', 'sidoNm']);
  });
}

// --- 메타데이터: 특정 지역의 휴양림 목록 -------------------------------
export async function fetchInstitutions(regionCode) {
  return withContext(async (context) => {
    const page = await context.newPage();
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const data = await page.evaluate(async (rc) => {
      const csrf = document.querySelector('[name=_csrf]')?.value || '';
      const res = await fetch(
        `/rep/or/selectInsttListForSearch.do?_csrf=${csrf}&srchSido=${encodeURIComponent(rc)}`,
        { headers: { 'X-Ajax-call': 'true' } },
      );
      return res.json();
    }, regionCode);
    const list = Array.isArray(data) ? data : data?.insttList || [];
    const TYPE = { '00': '국립', '01': '국립', '02': '사립', '03': '공립' };
    return list
      .map((o) => ({
        code: String(o.insttId ?? o.id ?? ''),
        name: (o.insttNm ?? o.name ?? '').trim(),
        type: TYPE[o.insttTpCd] || '',
      }))
      .filter((x) => x.code && x.name);
  });
}

function normalizeCodeList(list, idKeys, nameKeys) {
  if (!Array.isArray(list)) return [];
  const pick = (obj, keys) => {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return String(obj[k]);
    return '';
  };
  return list
    .map((o) => ({ code: pick(o, idKeys), name: pick(o, nameKeys).trim() }))
    .filter((x) => x.code && x.name);
}

// --- 핵심: 예약 가능 현황 검색 -----------------------------------------
// params: { regionCode, instittId, beginDate(yyyyMMdd), endDate, nights, people, houseCamp('01'|'02'), keyword }
// 반환: { items: [...], availableCount, totalCount, resultUrl, debugFile? }
export async function searchAvailability(params, { tag = 'search' } = {}) {
  return withContext(async (context) => {
    const page = await context.newPage();
    await page.goto(MAIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 페이지 자체 폼 + NetFunnel 흐름을 그대로 재현하여 검색 제출
    await page.evaluate(submitSearchInBrowser, params);

    // 결과 페이지로의 네비게이션 대기
    await page
      .waitForLoadState('networkidle', { timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1200);

    const resultUrl = page.url();

    // 1순위: 브라우저 DOM에서 직접 추출
    let parsed;
    try {
      parsed = await page.evaluate(domExtractor);
    } catch {
      parsed = { items: [], availableCount: 0, totalCount: 0, pageHasResults: false };
    }
    // 폴백: DOM 추출이 비었으면 HTML 휴리스틱
    const html = await page.content();
    if (!parsed.pageHasResults) {
      const fb = parseSearchResult(html, params);
      if (fb.pageHasResults) parsed = fb;
    }

    // 키워드 필터(객실명 등)
    if (params.keyword && Array.isArray(parsed.items) && parsed.items.length) {
      const kw = params.keyword.trim();
      parsed.items = parsed.items.filter((i) => (i.title + ' ' + i.snippet).includes(kw));
      parsed.availableCount = parsed.items.filter((i) => i.available).length;
      parsed.totalCount = parsed.items.length;
    }

    let debugFile;
    if (config.debugDump || parsed.availableCount === 0) {
      debugFile = dumpDebug(tag, html, await safeShot(page));
    }
    return { ...parsed, resultUrl, debugFile };
  });
}

// 브라우저 컨텍스트 안에서 실행되는 함수(직렬화되어 주입됨)
function submitSearchInBrowser(p) {
  return new Promise((resolve) => {
    const form = document.forms['srch_frm'];
    const set = (name, val) => {
      const el = form?.elements[name];
      if (el) el.value = val;
    };
    const useInstitt = p.instittId && String(p.instittId).trim() !== '';

    set('srchInsttArcd', p.regionCode || '');
    set('srchInsttId', useInstitt ? p.instittId : '');
    set('srchRsrvtBgDt', p.beginDate);
    set('srchRsrvtEdDt', p.endDate);
    set('srchStngNofpr', p.people || 2);
    set('srchSthngCnt', p.nights || 1);
    set('srchUseDt', p.beginDate);
    set('houseCampSctin', useInstitt ? '' : p.houseCamp || '01');
    set('rsrvtWtngSctin', '01');
    set('rsrvtPssblYn', 'N'); // N = 전체 노출(가용/마감 모두) → 우리가 직접 가용 판별
    set('gNowPage', '1');

    const url = useInstitt
      ? '/rep/or/sssn/fcfsRsrvtPssblGoodsDetls.do'
      : '/rep/or/fcfsRsrvtRcrfrDtlDetls.do';
    const actionId = useInstitt ? 'action2' : 'action1';

    form.setAttribute('method', 'get');

    const doSubmit = (key) => {
      if (key) set('netfunnel_key', key);
      form.setAttribute('action', url);
      form.submit();
      resolve(true);
    };

    // NetFunnel 대기열 통과 시도. 없거나 실패하면 키 없이 제출(저트래픽 시 통과).
    let settled = false;
    const fallback = setTimeout(() => {
      if (!settled) {
        settled = true;
        doSubmit(null);
      }
    }, 8000);

    try {
      if (typeof window.NetFunnel_Action === 'function') {
        window.NetFunnel_Action(
          { action_id: actionId, service_id: 'service_1' },
          {
            success: (ev, ret) => {
              if (settled) return;
              settled = true;
              clearTimeout(fallback);
              doSubmit(ret?.data?.key || null);
            },
            stop: () => {
              if (settled) return;
              settled = true;
              clearTimeout(fallback);
              doSubmit(null);
            },
            error: () => {
              if (settled) return;
              settled = true;
              clearTimeout(fallback);
              doSubmit(null);
            },
          },
        );
      } else {
        settled = true;
        clearTimeout(fallback);
        doSubmit(null);
      }
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(fallback);
        doSubmit(null);
      }
    }
  });
}

async function safeShot(page) {
  try {
    const buf = await page.screenshot({ fullPage: true });
    return buf;
  } catch {
    return null;
  }
}

function dumpDebug(tag, html, shotBuf) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(DEBUG_DIR, `${tag}-${stamp}`);
  fs.writeFileSync(`${base}.html`, html, 'utf8');
  if (shotBuf) fs.writeFileSync(`${base}.png`, shotBuf);
  return `${base}.html`;
}
