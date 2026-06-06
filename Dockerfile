# node:sqlite 내장 모듈 사용 → Node 22+ 필요 (Playwright 공식 이미지는 Node 20이라 미사용)
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HEADLESS=true \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 의존성 설치 + Chromium + OS 의존 라이브러리
COPY package*.json ./
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force

COPY . .

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
