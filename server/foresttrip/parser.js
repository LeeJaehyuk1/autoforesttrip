// 숲나들e 지역검색 결과 페이지에서 휴양림별 예약가능 객실 수를 추출한다.
//
// 실제 DOM 구조(2026-06 기준):
//   div.rc_item
//     div.rc_ti > i        => "[예약가능]" 뱃지(가용 시에만)
//     div.rc_ti > b        => "[사립](양평군)양평설매재자연휴양림"
//     div.ut_roomcount     => "예약가능 객실 수 : 8"
//     div.ut_button a[onclick="fn_fsfsRsrvtPssblGoodsList('ID04030004')"]  => insttId
//   결과는 #searchResultList 와 #searchResultMap 양쪽에 중복 렌더되므로 dedupe 필요.

export const AVAIL_POS = ['예약하기', '예약가능', '예약 가능', '신청하기', '예약신청', '잔여'];
export const AVAIL_NEG = ['마감', '예약불가', '예약대기', '대기신청', '신청마감', '매진', '예약 마감'];

// page.evaluate(domExtractor) 로 브라우저 컨텍스트에서 실행됨. 외부 스코프 참조 금지.
export function domExtractor() {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  // 결과 컨테이너 한 곳만 선택(중복 방지)
  let scope =
    document.querySelector('#searchResultList') ||
    document.querySelector('#searchResultMap') ||
    document;
  let cards = Array.from(scope.querySelectorAll('.rc_item'));

  // 컨테이너가 비어있으면 문서 전체에서 dedupe
  if (cards.length === 0) cards = Array.from(document.querySelectorAll('.rc_item'));

  const seen = new Set();
  const items = [];
  for (const el of cards) {
    const nameRaw = text(el.querySelector('.rc_ti b')) || text(el.querySelector('.rc_ti'));
    const badge = text(el.querySelector('.rc_ti i'));
    const countText = text(el.querySelector('.ut_roomcount'));
    const m = countText.match(/(\d+)/);
    const remain = m ? Number(m[1]) : null;

    // insttId 추출
    let instttId = '';
    const onclick =
      el.querySelector('.ut_button a')?.getAttribute('onclick') ||
      el.querySelector('a[onclick*="fn_fsfsRsrvtPssblGoodsList"]')?.getAttribute('onclick') ||
      '';
    const im = onclick.match(/fn_fsfsRsrvtPssblGoodsList\(['"]([^'"]+)['"]/);
    if (im) instttId = im[1];

    const available = badge.includes('예약가능') || (remain != null && remain > 0);

    const key = instttId || nameRaw;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);

    items.push({
      instttId,
      title: (nameRaw || '').slice(0, 120),
      available: !!available,
      remain,
      snippet: countText || badge,
    });
  }

  // 카드가 전혀 없으면(레이아웃 변경 등) 키워드 휴리스틱으로라도 신호 파악
  if (items.length === 0) {
    const bodyText = document.body.innerText || '';
    const pos = (bodyText.match(/예약가능/g) || []).length;
    return {
      items: [],
      availableCount: 0,
      totalCount: 0,
      pageHasResults: pos > 0,
      note: pos > 0 ? '카드 셀렉터 미매칭(레이아웃 변경 가능)' : '결과 없음',
    };
  }

  return {
    items,
    availableCount: items.filter((i) => i.available).length,
    totalCount: items.length,
    pageHasResults: true,
  };
}

// HTML 문자열 휴리스틱 폴백(브라우저 DOM 추출이 불가능한 오프라인/테스트 상황용)
export function parseSearchResult(html) {
  const items = [];
  const re = /<div class="rc_item">([\s\S]*?)(?=<div class="rc_item">|<script>\s*insttItems\.arrInstt|$)/g;
  let mm;
  while ((mm = re.exec(html)) !== null) {
    const chunk = mm[1];
    const name = (chunk.match(/<b>([^<]+)<\/b>/) || [])[1] || '';
    const cnt = (chunk.match(/예약가능 객실 수\s*:\s*(\d+)/) || [])[1];
    const remain = cnt != null ? Number(cnt) : null;
    const available = /\[예약가능\]/.test(chunk) || (remain != null && remain > 0);
    items.push({ title: name.trim(), available, remain, snippet: cnt ? `객실 ${cnt}` : '' });
  }
  return {
    items,
    availableCount: items.filter((i) => i.available).length,
    totalCount: items.length,
    pageHasResults: items.length > 0,
    fallback: true,
  };
}
