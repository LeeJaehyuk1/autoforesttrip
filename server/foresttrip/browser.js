import { chromium } from 'playwright';
import { config } from '../config.js';

// 단일 브라우저 인스턴스를 공유하고, 필요 시 자동 재기동한다.
let browserPromise = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
];

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: config.headless, args: LAUNCH_ARGS })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// 익명(비로그인) 검색용 컨텍스트. 매 검색마다 새로 만들고 닫는다.
export async function withContext(fn, { storageState } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    storageState,
    // 한국 IP 프록시 설정 시 모든 요청을 해당 프록시로 라우팅
    proxy: config.proxy || undefined,
  });
  try {
    return await fn(context);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}
