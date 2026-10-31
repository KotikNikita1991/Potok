// Рабочий календарь: обычная неделя, праздники и настройки конкретных дней.

import { holidayInfo } from './holidays.js';
import { parseHM, weekdayOf } from './time.js';

function workday(on) {
  return {
    on,
    start: '09:00',
    end: '17:00',
    breaks: [{ start: '12:00', end: '13:00', label: 'Обед' }],
  };
}

export function defaultWeek() {
  return {
    0: workday(false),
    1: workday(true),
    2: workday(true),
    3: workday(true),
    4: workday(true),
    5: workday(true),
    6: workday(false),
  };
}

export function calendarOf(doc) {
  return { week: doc.settings.week, holidays: doc.settings.holidays, days: doc.days };
}

// Что происходит в этот день: источник 'custom' — настройка самого дня,
// 'holiday' — праздник, 'transfer' — рабочий выходной, 'week' — обычная неделя.
export function dayPlan(key, calendar) {
  const custom = calendar.days?.[key];
  const holiday = holidayInfo(key);
  if (custom && !custom.removed) {
    return { ...custom, breaks: custom.breaks ?? [], source: 'custom', holiday: holiday?.off ? holiday.name : null };
  }
  const base = calendar.week[weekdayOf(key)];
  if (calendar.holidays && holiday?.off) {
    return { ...base, on: false, source: 'holiday', holiday: holiday.name };
  }
  if (calendar.holidays && holiday?.work) {
    return { ...calendar.week[1], on: true, source: 'transfer', holiday: null };
  }
  return { ...base, source: 'week', holiday: null };
}

function cut(spans, from, to) {
  if (to <= from) return spans;
  const out = [];
  for (const [s, e] of spans) {
    if (to <= s || from >= e) {
      out.push([s, e]);
      continue;
    }
    if (from > s) out.push([s, from]);
    if (to < e) out.push([to, e]);
  }
  return out;
}

// Рабочие отрезки дня в минутах от полуночи, без перерывов.
export function workSpans(plan) {
  if (!plan.on) return [];
  const start = parseHM(plan.start);
  const end = parseHM(plan.end);
  if (end <= start) return [];
  let spans = [[start, end]];
  for (const pause of plan.breaks ?? []) {
    spans = cut(spans, parseHM(pause.start), parseHM(pause.end));
  }
  return spans;
}

export function workMinutes(plan) {
  return workSpans(plan).reduce((sum, [s, e]) => sum + e - s, 0);
}

// Во сколько закончить день, чтобы отработать нужное число минут с учётом перерывов.
export function endForMinutes(start, breaks, minutes) {
  const pauses = (breaks ?? [])
    .map((pause) => [parseHM(pause.start), parseHM(pause.end)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let end = start + minutes;
  for (const [a, b] of pauses) {
    if (b <= start) continue;
    const from = Math.max(a, start);
    if (from < end) end += b - from;
  }
  return end;
}
