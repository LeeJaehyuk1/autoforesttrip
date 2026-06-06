import { EventEmitter } from 'node:events';

// 서버 내부 이벤트 → SSE 브로드캐스트용 단일 버스
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitJobUpdate(job) {
  bus.emit('event', { type: 'job', job });
}
export function emitLog(event) {
  bus.emit('event', { type: 'log', event });
}
export function emitToast(toast) {
  bus.emit('event', { type: 'toast', toast });
}
