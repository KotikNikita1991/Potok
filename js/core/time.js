// Дата и время в локальной зоне устройства. Ключ дня — строка 'YYYY-MM-DD'.

export const MINUTE = 60000;
export const STEP = 15; // минимальный шаг планирования, минуты

const pad = (n) => String(n).padStart(2, '0');

export function toKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m - 1, d];
}

export function atKey(key, minutes = 0) {
  const [y, m, d] = parts(key);
  return new Date(y, m, d, 0, minutes).getTime();
}

export function shiftKey(key, days) {
  const [y, m, d] = parts(key);
  return toKey(new Date(y, m, d + days).getTime());
}

export function weekdayOf(key) {
  const [y, m, d] = parts(key);
  return new Date(y, m, d).getDay();
}

export function parseHM(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function formatHM(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function minutesOfDay(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export function roundTo(value, step = STEP) {
  return Math.round(value / step) * step;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
