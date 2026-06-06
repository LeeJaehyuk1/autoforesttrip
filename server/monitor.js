import { searchAvailability } from './foresttrip/client.js';

const norm = (s) => (s || '').replace(/\s+/g, '').replace(/^\[[^\]]*\]/, '');

// 잡 1건 검사. 예약가능 현황을 평가해 반환.
// 반환: { found, availableCount, totalScanned, items, availableItems, signature, debugFile, resultUrl }
export async function runCheck(job) {
  const params = {
    regionCode: job.region_code,
    instttId: '', // 항상 지역검색으로 받아 견고한 파서 사용 → 이후 필터
    beginDate: job.begin_date,
    endDate: job.end_date,
    nights: job.nights || 1,
    people: job.people || 2,
    houseCamp: job.house_camp || '01',
  };

  const res = await searchAvailability(params, { tag: `job${job.id}` });
  let items = Array.isArray(res.items) ? res.items : [];

  // 특정 휴양림 지정 시 이름으로 필터
  if (job.institt_name) {
    const target = norm(job.institt_name);
    items = items.filter((i) => norm(i.title).includes(target) || (i.instttId && i.instttId === job.institt_id));
  }
  // 키워드(객실명/휴양림명) 필터
  if (job.keyword && job.keyword.trim()) {
    const kw = job.keyword.trim();
    items = items.filter((i) => (i.title + ' ' + (i.snippet || '')).includes(kw));
  }

  const availableItems = items.filter((i) => i.available);
  const signature = availableItems
    .map((i) => `${norm(i.title)}:${i.remain ?? '?'}`)
    .sort()
    .join('|');

  return {
    found: availableItems.length > 0,
    availableCount: availableItems.length,
    totalScanned: items.length,
    items,
    availableItems,
    signature,
    debugFile: res.debugFile,
    resultUrl: res.resultUrl,
  };
}
