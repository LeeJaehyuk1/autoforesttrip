// 라이브 정찰: 지역 목록 조회 + 한 건 검색하여 결과 DOM/파싱 확인 (읽기 전용)
import { fetchRegions, fetchInstitutions, searchAvailability } from '../server/foresttrip/client.js';
import { closeBrowser } from '../server/foresttrip/browser.js';

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function main() {
  console.log('=== 지역(시도) 목록 ===');
  const regions = await fetchRegions();
  console.log(JSON.stringify(regions, null, 2));

  if (!regions.length) {
    console.log('지역 목록을 가져오지 못함. 종료.');
    return;
  }

  // 약 2주 뒤 토요일~일요일
  const begin = new Date();
  begin.setDate(begin.getDate() + 14);
  const end = new Date(begin);
  end.setDate(end.getDate() + 1);

  const region = regions[0];
  console.log(`\n=== 휴양림 목록 (지역=${region.name}/${region.code}) ===`);
  const insts = await fetchInstitutions(region.code).catch((e) => {
    console.log('institutions err', e.message);
    return [];
  });
  console.log(JSON.stringify(insts.slice(0, 5), null, 2), `... 총 ${insts.length}개`);

  console.log(`\n=== 검색: ${region.name} ${yyyymmdd(begin)}~${yyyymmdd(end)} ===`);
  const result = await searchAvailability(
    {
      regionCode: region.code,
      instittId: '',
      beginDate: yyyymmdd(begin),
      endDate: yyyymmdd(end),
      nights: 1,
      people: 2,
      houseCamp: '01',
    },
    { tag: 'recon' },
  );
  console.log('resultUrl:', result.resultUrl);
  console.log('availableCount:', result.availableCount, 'totalCount:', result.totalCount);
  console.log('debugFile:', result.debugFile);
  console.log('items(샘플 8):', JSON.stringify((result.items || []).slice(0, 8), null, 2));
}

main()
  .catch((e) => console.error('FATAL', e))
  .finally(async () => {
    await closeBrowser();
    process.exit(0);
  });
