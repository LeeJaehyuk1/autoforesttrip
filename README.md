# 🌲 숲나들e 빈자리 모니터 (autoforesttrip)

전국 자연휴양림 통합예약 사이트 **[숲나들e](https://www.foresttrip.go.kr)** 의 예약 가능 현황을
주기적으로(1·5·10분 또는 직접 설정) 확인하고, **빈자리가 나면 텔레그램으로 즉시 알림**을 보내는 웹앱입니다.
PC·모바일 어디서든 같은 화면으로 접속해 모니터를 관리할 수 있고, 옵션으로 **베스트-에포트 자동예약**까지 시도합니다.

> 개인이 직접 새로고침하며 빈자리를 기다리는 일을 대신 해 주는 도구입니다.
> 본인 계정·본인 예약을 위한 용도로만 사용하세요.

---

## ✨ 주요 기능

- **지역/휴양림/날짜/인원/구분(휴양·야영)** 조건으로 모니터 등록
- **1분·5분·10분 또는 직접 입력** 주기로 자동 확인
- 휴양림별 **예약가능 객실 수**를 파싱해 빈자리 여부 판정
- **NetFunnel 대기열·CSRF 토큰**을 실제 브라우저(Playwright)로 자동 통과
- 빈자리 발견 시 **텔레그램 봇 알림** + 화면 토스트 + 알림음
- **실시간 대시보드**(SSE) — 여러 기기에서 동시에 상태 공유
- (옵션) **자동예약 시도**: 로그인 → 객실선택 → 예약페이지 진입까지 자동, 최종 결제만 사용자가 완료
- 로그인 정보는 **AES-256-GCM 암호화** 저장
- 대시보드 **비밀번호 보호**(클라우드 배포 시 권장)

---

## 🚀 빠른 시작 (로컬)

요구사항: **Node.js 22 이상** (Node 24 권장 — 내장 `node:sqlite` 사용으로 별도 DB 불필요)

```bash
npm install                 # 의존성 + Chromium 자동 설치
cp .env.example .env        # 환경설정 작성 (Windows: copy .env.example .env)
npm start
```

브라우저에서 `http://localhost:3000` 접속. 같은 와이파이의 휴대폰에서는
`http://<PC-IP>:3000` 으로 접속하면 됩니다.

---

## 🔔 텔레그램 알림 설정

1. 텔레그램에서 **@BotFather** 에게 `/newbot` → 봇 토큰 발급
2. 만든 봇과 대화창을 연 뒤 아무 메시지나 전송
3. **@userinfobot** 에게 말을 걸어 본인 **chat id** 확인
4. `.env` 에 입력:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_CHAT_ID=123456789        # 여러 명이면 콤마로 구분
```

5. 대시보드 → 설정 → **테스트 전송** 으로 연결 확인

---

## ⚙️ 환경설정 (.env)

| 변수 | 설명 |
|------|------|
| `PORT` | 서버 포트 (기본 3000) |
| `APP_PASSWORD` | 대시보드 접근 비밀번호. 비우면 인증 없음. **클라우드 배포 시 반드시 설정** |
| `ENCRYPTION_KEY` | 로그인 정보 암호화 키. 비우면 자동 생성되어 `data/secret.key` 저장 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 텔레그램 알림 |
| `HEADLESS` | 브라우저 창 숨김 여부 (서버/클라우드는 `true`) |
| `DEBUG_DUMP` | 빈자리 미발견 시에도 결과 HTML/스크린샷을 `debug/` 에 저장 |

---

## ☁️ 클라우드 배포 (Docker)

이 앱은 실제 Chromium 브라우저를 구동하므로 **상시 켜진 서버/VPS(메모리 1~2GB 권장)** 또는
Playwright를 지원하는 컨테이너 플랫폼(Render·Railway·Fly.io·자체 VPS 등)에 배포합니다.

```bash
# 1) .env 작성 (APP_PASSWORD, TELEGRAM_* 필수)
cp .env.example .env

# 2) 빌드 & 실행
docker compose up -d --build

# 3) 로그 확인
docker compose logs -f
```

- `data/` 볼륨에 SQLite·암호화키가 보존됩니다(컨테이너 재시작/재배포 시 유지).
- 외부 노출 시 **HTTPS 리버스 프록시(Caddy/Nginx)** 뒤에 두고 `APP_PASSWORD` 를 설정하세요.

### 단일 컨테이너로 직접 실행
```bash
docker build -t autoforesttrip .
docker run -d --name autoforesttrip -p 3000:3000 \
  --env-file .env --shm-size=1g -v $(pwd)/data:/app/data autoforesttrip
```

---

## 🤖 자동예약에 대한 안내 (중요)

자동예약은 **빈자리 발견 → 로그인 → 휴양림 객실목록 진입 → 첫 가용 객실 예약 클릭 → 예약/결제 페이지 도달**
까지 진행하고 **멈춥니다.** 비가역적인 **최종 결제·확정 버튼은 누르지 않으며**, 텔레그램으로 도달한
페이지 링크와 화면 캡처를 보냅니다. 사용자는 그 링크에서 본인 인증·결제로 예약을 마무리하면 됩니다.

왜 끝까지 자동화하지 않나:

- 숲나들e는 인기 시간대에 **NetFunnel 대기열**이 강하게 걸리고, 휴양림마다 객실선택/약관 화면이 달라
  100% 자동 완료를 보장하기 어렵습니다.
- 최종 결제는 카드/간편결제(PG) 본인 인증이 필요해 안전하게 자동화할 수 없습니다.
- 예약은 보통 **보유(holding) 시간 제한**이 있으므로, 알림을 받으면 **즉시** 마무리하세요.

> 자동예약 기능은 사이트 약관·정책 변경에 따라 동작이 달라질 수 있습니다. 사용 책임은 사용자에게 있습니다.

---

## 🧱 구조

```
server/
  index.js              Express + REST + SSE + 정적 서빙 + 비밀번호 인증
  config.js             환경설정 로더
  db.js                 node:sqlite 스키마/리포지토리 (jobs / credentials / events)
  crypto.js             AES-256-GCM 자격증명 암호화
  monitor.js            잡 1건 검사 로직(빈자리 평가)
  scheduler.js          주기 실행 + 동시성 제한 + 알림/자동예약 트리거
  telegram.js           텔레그램 Bot API 전송
  bus.js                내부 이벤트 버스(→ SSE)
  foresttrip/
    browser.js          Playwright 브라우저/컨텍스트 관리
    client.js           지역/휴양림 메타 조회 + 검색(NetFunnel·CSRF 처리)
    parser.js           결과 DOM → 휴양림별 예약가능 객실 수 추출
    booking.js          베스트-에포트 자동예약(로그인~예약페이지)
public/                 모바일 우선 반응형 대시보드 (index.html / styles.css / app.js)
scripts/recon.js        라이브 정찰(파서 보정용, 읽기 전용)
```

---

## 🔧 동작 점검 / 디버깅

- 결과 파싱이 비면 `.env` 에 `DEBUG_DUMP=true` 후 재시도 → `debug/` 의 HTML·PNG 로 셀렉터 확인
- 숲나들e DOM이 바뀌면 `server/foresttrip/parser.js` 의 `domExtractor` 셀렉터만 보정하면 됩니다
- 정찰 스크립트: `node scripts/recon.js` (지역 목록 + 1회 검색 결과 출력)

---

## ⚠️ 면책

본 프로젝트는 개인의 예약 편의를 위한 도구이며, 숲나들e 및 산림청과 무관합니다.
과도한 빈도의 조회는 자제하고(권장 최소 1분), 사이트 이용약관을 준수해 본인 책임하에 사용하세요.
