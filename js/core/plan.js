// Расчёт графика: задачи идут одна за другой и занимают только рабочее время.

import { calendarOf, dayPlan, workSpans } from './calendar.js';
import { MINUTE, STEP, atKey, shiftKey, toKey } from './time.js';

const HORIZON_DAYS = 1500; // дальше не ищем, чтобы не зависнуть, если рабочих дней нет вообще

function cut(spans, from, to) {
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

export function totalMinutes(segments) {
  return Math.round(segments.reduce((sum, [s, e]) => sum + e - s, 0) / MINUTE);
}

export function mergeSegments(segments) {
  const sorted = [...segments].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// Часы рабочего времени: всё, что не обед, не ночь, не выходной и не закреплённое событие.
export class WorkClock {
  constructor(calendar, blocks = []) {
    this.calendar = calendar;
    this.blocks = blocks;
    this.cache = new Map();
  }

  spansOn(key) {
    let spans = this.cache.get(key);
    if (spans) return spans;
    spans = workSpans(dayPlan(key, this.calendar)).map(([a, b]) => [atKey(key, a), atKey(key, b)]);
    for (const [a, b] of this.blocks) spans = cut(spans, a, b);
    this.cache.set(key, spans);
    return spans;
  }

  *iterate(from) {
    let key = toKey(from);
    for (let i = 0; i < HORIZON_DAYS; i += 1) {
      for (const [s, e] of this.spansOn(key)) {
        if (e > from) yield [Math.max(s, from), e];
      }
      key = shiftKey(key, 1);
    }
  }

  isWorking(t) {
    return this.spansOn(toKey(t)).some(([s, e]) => t >= s && t < e);
  }

  // Первый рабочий момент не раньше t, либо null, если рабочего времени нет.
  next(t) {
    for (const [s] of this.iterate(t)) return s;
    return null;
  }

  // Занимает minutes рабочих минут начиная с t.
  allocate(t, minutes) {
    if (minutes <= 0) return { segments: [], end: t };
    let left = minutes * MINUTE;
    const segments = [];
    for (const [s, e] of this.iterate(t)) {
      const take = Math.min(left, e - s);
      segments.push([s, s + take]);
      left -= take;
      if (left <= 0) return { segments, end: s + take };
    }
    return { segments, end: null };
  }

  slice(a, b) {
    if (b <= a) return [];
    const out = [];
    for (const [s, e] of this.iterate(a)) {
      if (s >= b) break;
      out.push([s, Math.min(e, b)]);
    }
    return out;
  }

  between(a, b) {
    return totalMinutes(this.slice(a, b));
  }
}

export function remainingOf(task) {
  const left = task.dur - (task.spent || 0);
  return left > 0 ? left : STEP;
}

function lateBy(task, end) {
  if (!task.deadline || end == null || end <= task.deadline) return 0;
  return Math.round((end - task.deadline) / MINUTE);
}

export function isPinned(task) {
  return !task.deleted && task.status === 'queue' && task.pinAt != null;
}

export function computePlan(doc, now) {
  const tasks = Object.values(doc.tasks);
  const pins = tasks.filter(isPinned).sort((a, b) => a.pinAt - b.pinAt);
  const clock = new WorkClock(calendarOf(doc), pins.map((t) => [t.pinAt, t.pinAt + t.dur * MINUTE]));

  const items = [];
  const byId = new Map();
  let cursor = doc.plan.anchor ?? now;
  let stuck = false;

  doc.plan.order.forEach((id, index) => {
    const task = doc.tasks[id];
    if (!task || task.deleted) return;
    if (stuck) return;

    const gap = clock.allocate(cursor, task.lag || 0);
    const start = gap.end == null ? null : clock.next(gap.end);
    const run = start == null ? { segments: [], end: null } : clock.allocate(start, remainingOf(task));
    if (run.end == null) {
      stuck = true;
      return;
    }

    const segments = run.segments.map(([s, e]) => ({ s, e, kind: 'plan' }));
    const plannedEnd = run.end;
    let end = plannedEnd;
    let overrunMin = 0;
    // Живой план: первая задача не может закончиться в прошлом, она растягивается до «сейчас».
    if (index === 0 && plannedEnd < now) {
      const extra = clock.slice(plannedEnd, now);
      overrunMin = totalMinutes(extra);
      for (const [s, e] of extra) segments.push({ s, e, kind: 'over' });
      end = now;
    }

    const first = index === 0;
    const item = {
      id,
      task,
      index,
      gap: gap.segments.map(([s, e]) => ({ s, e })),
      start,
      end,
      plannedEnd,
      segments,
      overrunMin,
      isCurrent: first && start <= now,
      isOverdue: first && start <= now && plannedEnd < now,
      elapsedMin: first && start <= now ? clock.between(start, Math.min(now, end)) : 0,
      remainingMin: first ? clock.between(Math.max(now, start), plannedEnd) : remainingOf(task),
      late: lateBy(task, end),
    };
    items.push(item);
    byId.set(id, item);
    cursor = end;
  });

  const pinned = pins.map((task) => {
    const start = task.pinAt;
    const end = start + task.dur * MINUTE;
    const item = {
      id: task.id,
      task,
      pinned: true,
      start,
      end,
      plannedEnd: end,
      gap: [],
      segments: [{ s: start, e: end, kind: 'pin' }],
      late: lateBy(task, end),
    };
    byId.set(task.id, item);
    return item;
  });

  const planEnd = items.length ? items[items.length - 1].end : null;
  return { now, clock, items, pinned, byId, planEnd, stuck };
}
