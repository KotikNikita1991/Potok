import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultWeek, endForMinutes } from '../js/core/calendar.js';
import { createDoc, createTask } from '../js/core/doc.js';
import { computePlan } from '../js/core/plan.js';
import { completeTask, deleteTask, extendTask, placeTask, restartFirst, settle } from '../js/core/ops.js';
import { impactOf, simulate, suggestIndex } from '../js/core/whatif.js';
import { fmtDur, parseDur } from '../js/core/format.js';
import { atKey } from '../js/core/time.js';

const at = (key, hm) => {
  const [h, m = 0] = hm.split(':').map(Number);
  return atKey(key, h * 60 + m);
};

function everyDayWeek(breaks = [{ start: '12:00', end: '13:00', label: 'Обед' }]) {
  const week = defaultWeek();
  for (const day of Object.keys(week)) week[day] = { on: true, start: '09:00', end: '17:00', breaks };
  return week;
}

function makeDoc(tasks, { anchor, week, holidays = false } = {}) {
  const doc = createDoc();
  doc.settings.holidays = holidays;
  if (week) doc.settings.week = week;
  doc.plan.anchor = anchor ?? null;
  for (const fields of tasks) {
    const task = createTask({ status: 'queue', ...fields }, 0);
    task.id = fields.id;
    doc.tasks[task.id] = task;
    if (task.pinAt == null) doc.plan.order.push(task.id);
  }
  return doc;
}

const times = (item) => item.segments.map(({ s, e }) => [new Date(s).toLocaleString('ru-RU'), new Date(e).toLocaleString('ru-RU')]);

test('повторяет пример со скриншота: задача 3 заканчивается 3 ноября в 17:00', () => {
  // На скрине колонки 09,10,11,[обед 12],13,14,16 — час 15–16 пропущен, поэтому здесь он как перерыв.
  const week = everyDayWeek([
    { start: '12:00', end: '13:00', label: 'Обед' },
    { start: '15:00', end: '16:00', label: 'Пропуск' },
  ]);
  const doc = makeDoc(
    [
      { id: 'a', dur: 180 },
      { id: 'b', dur: 180, lag: 60 },
      { id: 'c', dur: 600, lag: 60 },
    ],
    { anchor: at('2026-11-01', '09:00'), week },
  );
  const plan = computePlan(doc, at('2026-10-31', '20:00'));
  const [a, b, c] = plan.items;
  assert.equal(a.start, at('2026-11-01', '09:00'));
  assert.equal(a.end, at('2026-11-01', '12:00'));
  assert.equal(b.start, at('2026-11-01', '14:00'));
  assert.equal(b.end, at('2026-11-02', '10:00'), 'задача 2 заканчивается 2 ноября в 10:00');
  assert.equal(c.start, at('2026-11-02', '11:00'), 'задача 3 отложена на час');
  assert.equal(c.end, at('2026-11-03', '17:00'));
});

test('задача не занимает обед, ночь и выходные', () => {
  // 30 октября 2026 — пятница, дальше суббота и воскресенье.
  const doc = makeDoc([{ id: 'a', dur: 8 * 60 }], { anchor: at('2026-10-30', '15:00') });
  const [item] = computePlan(doc, at('2026-10-30', '15:00')).items;
  assert.deepEqual(
    item.segments.map(({ s, e }) => [s, e]),
    [
      [at('2026-10-30', '15:00'), at('2026-10-30', '17:00')],
      [at('2026-11-02', '09:00'), at('2026-11-02', '12:00')],
      [at('2026-11-02', '13:00'), at('2026-11-02', '16:00')],
    ],
    JSON.stringify(times(item)),
  );
});

test('праздники РФ пропускаются и отключаются настройкой', () => {
  // 3 ноября 2026 — вторник, 4 ноября — праздник, 5 ноября — четверг.
  const base = { anchor: at('2026-11-03', '16:00') };
  const withHolidays = makeDoc([{ id: 'a', dur: 120 }], { ...base, holidays: true });
  assert.equal(computePlan(withHolidays, base.anchor).items[0].end, at('2026-11-05', '10:00'));
  const without = makeDoc([{ id: 'a', dur: 120 }], { ...base, holidays: false });
  assert.equal(computePlan(without, base.anchor).items[0].end, at('2026-11-04', '10:00'));
});

test('рабочая суббота из производственного календаря заполняется', () => {
  // 20 февраля 2027 — суббота, рабочая по переносу; 22 и 23 февраля выходные.
  const doc = makeDoc([{ id: 'a', dur: 120 }], { anchor: at('2027-02-19', '16:00'), holidays: true });
  const [item] = computePlan(doc, at('2027-02-19', '16:00')).items;
  assert.equal(item.end, at('2027-02-20', '10:00'));
});

test('каждый день может начинаться и заканчиваться в своё время', () => {
  const doc = makeDoc([{ id: 'a', dur: 13 * 60 }], { anchor: at('2026-11-02', '09:00') });
  doc.days['2026-11-02'] = { on: true, start: '09:00', end: '14:00', breaks: [] }; // 5 ч
  doc.days['2026-11-03'] = { on: true, start: '12:00', end: '18:00', breaks: [] }; // 6 ч
  doc.days['2026-11-04'] = { on: false, start: '09:00', end: '17:00', breaks: [] }; // выходной среди недели
  doc.days['2026-11-05'] = { on: true, start: '17:00', end: '21:00', breaks: [] }; // остаток 2 ч
  const [item] = computePlan(doc, at('2026-11-02', '09:00')).items;
  assert.equal(item.end, at('2026-11-05', '19:00'));
  assert.equal(item.segments[1].s, at('2026-11-03', '12:00'));
  assert.equal(item.segments[2].s, at('2026-11-05', '17:00'));
});

test('вставка сдвигает все следующие задачи вправо на свою длительность', () => {
  const now = at('2026-11-02', '08:00');
  const doc = makeDoc([{ id: 'a', dur: 120 }, { id: 'b', dur: 120 }, { id: 'c', dur: 120 }], { anchor: now });
  const before = computePlan(doc, now);
  doc.tasks.n = { ...createTask({}, now), id: 'n', dur: 60 };
  placeTask(doc, 'n', { kind: 'after', id: 'a' }, now);
  const after = computePlan(doc, now);
  assert.deepEqual(after.items.map((i) => i.id), ['a', 'n', 'b', 'c']);
  assert.equal(after.byId.get('a').end, before.byId.get('a').end);
  assert.equal(after.byId.get('n').start, before.byId.get('a').end);
  assert.equal(after.clock.between(before.byId.get('c').end, after.byId.get('c').end), 60);
});

test('ручной запас сохраняется и едет вместе с задачей', () => {
  const now = at('2026-11-02', '08:00');
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 60, lag: 60 }], { anchor: now });
  assert.equal(computePlan(doc, now).byId.get('b').start, at('2026-11-02', '11:00'));
  doc.tasks.a.dur = 120;
  const plan = computePlan(doc, now);
  assert.equal(plan.byId.get('b').start, at('2026-11-02', '13:00'), 'запас считается в рабочем времени и обходит обед');
  assert.deepEqual(plan.byId.get('b').gap, [{ s: at('2026-11-02', '11:00'), e: at('2026-11-02', '12:00') }]);
});

test('новая задача сначала расходует запас следующей', () => {
  const now = at('2026-11-02', '08:00');
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 60, lag: 120 }], { anchor: now });
  const startBefore = computePlan(doc, now).byId.get('b').start;
  doc.tasks.n = { ...createTask({}, now), id: 'n', dur: 60 };
  placeTask(doc, 'n', { kind: 'after', id: 'a' }, now);
  assert.equal(doc.tasks.b.lag, 60);
  assert.equal(computePlan(doc, now).byId.get('b').start, startBefore);
});

test('живой план: просроченная задача растягивается, остальные едут вправо', () => {
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '10:30');
  const plan = computePlan(doc, now);
  const [a, b] = plan.items;
  assert.equal(a.isOverdue, true);
  assert.equal(a.overrunMin, 30);
  assert.equal(a.plannedEnd, at('2026-11-02', '10:00'));
  assert.equal(a.end, now);
  assert.equal(b.start, now);
  assert.equal(b.end, at('2026-11-02', '11:30'));
});

test('живой план: закрыла раньше — всё подтягивается влево', () => {
  const doc = makeDoc([{ id: 'a', dur: 240 }, { id: 'b', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '10:00');
  completeTask(doc, 'a', now);
  const plan = computePlan(doc, now);
  assert.equal(plan.items[0].id, 'b');
  assert.equal(plan.items[0].start, now);
  assert.equal(doc.tasks.a.status, 'done');
  assert.deepEqual(doc.tasks.a.history, [[at('2026-11-02', '09:00'), now]]);
  assert.equal(doc.tasks.a.spent, 60);
});

test('завершение задним числом запускает следующую с этого момента', () => {
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 120 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '15:00');
  completeTask(doc, 'a', now, at('2026-11-02', '10:00'));
  const [b] = computePlan(doc, now).items;
  assert.equal(b.start, at('2026-11-02', '10:00'));
  assert.equal(b.isOverdue, true, 'следующая задача тоже успела стать просроченной');
});

test('прерывание: текущая режется, остаток уходит после новой задачи', () => {
  const doc = makeDoc([{ id: 'a', dur: 240 }, { id: 'b', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '10:00');
  doc.tasks.n = { ...createTask({}, now), id: 'n', dur: 60 };
  placeTask(doc, 'n', { kind: 'now' }, now);
  const plan = computePlan(doc, now);
  assert.deepEqual(plan.items.map((i) => i.id), ['n', 'a', 'b']);
  assert.equal(plan.byId.get('n').start, now);
  assert.equal(plan.byId.get('n').end, at('2026-11-02', '11:00'));
  assert.deepEqual(doc.tasks.a.history, [[at('2026-11-02', '09:00'), now]]);
  assert.equal(doc.tasks.a.spent, 60);
  const a = plan.byId.get('a');
  assert.equal(a.start, at('2026-11-02', '11:00'));
  assert.equal(a.end, at('2026-11-02', '15:00'), 'остаток 3 ч обходит обед');
});

test('перенос задачи из конца на сегодня не теряет остальные', () => {
  const now = at('2026-11-02', '09:00');
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 60 }, { id: 'c', dur: 60 }], { anchor: now });
  placeTask(doc, 'c', { kind: 'next' }, now);
  assert.deepEqual(doc.plan.order, ['a', 'c', 'b']);
  placeTask(doc, 'b', { kind: 'backlog' }, now);
  assert.deepEqual(doc.plan.order, ['a', 'c']);
  assert.equal(doc.tasks.b.status, 'backlog');
  placeTask(doc, 'b', { kind: 'end' }, now);
  assert.deepEqual(doc.plan.order, ['a', 'c', 'b']);
});

test('закреплённая задача не двигается, остальные обходят её как обед', () => {
  const now = at('2026-11-02', '09:00');
  const doc = makeDoc(
    [
      { id: 'a', dur: 120 },
      { id: 'call', dur: 60, pinAt: at('2026-11-02', '10:00') },
    ],
    { anchor: now },
  );
  const plan = computePlan(doc, now);
  const a = plan.byId.get('a');
  assert.equal(a.end, at('2026-11-02', '12:00'));
  assert.equal(a.segments.length, 2);
  assert.equal(plan.byId.get('call').start, at('2026-11-02', '10:00'));
});

test('прошедшие закреплённые события завершаются сами', () => {
  const doc = makeDoc([{ id: 'call', dur: 60, pinAt: at('2026-11-02', '10:00') }]);
  assert.equal(settle(doc, at('2026-11-02', '10:30')), false);
  assert.equal(settle(doc, at('2026-11-02', '11:00')), true);
  assert.equal(doc.tasks.call.status, 'done');
  assert.deepEqual(doc.tasks.call.history, [[at('2026-11-02', '10:00'), at('2026-11-02', '11:00')]]);
});

test('постановка на дату: задача встаёт на ближайшую границу, пустое место становится запасом', () => {
  const now = at('2026-11-02', '09:00');
  const doc = makeDoc([{ id: 'a', dur: 120 }], { anchor: now });
  doc.tasks.n = { ...createTask({}, now), id: 'n', dur: 60 };
  placeTask(doc, 'n', { kind: 'moment', at: at('2026-11-03', '09:00') }, now);
  const plan = computePlan(doc, now);
  assert.equal(plan.byId.get('n').start, at('2026-11-03', '09:00'));
  assert.equal(doc.tasks.n.lag, 5 * 60, 'с 11 до 17 минус обед');
});

test('постановка на сегодня не прерывает текущую задачу', () => {
  const now = at('2026-11-02', '10:00');
  const doc = makeDoc([{ id: 'a', dur: 240 }, { id: 'b', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  doc.tasks.n = { ...createTask({}, now), id: 'n', dur: 60 };
  placeTask(doc, 'n', { kind: 'moment', at: atKey('2026-11-02', 0) }, now);
  assert.deepEqual(doc.plan.order, ['a', 'n', 'b']);
  assert.equal(doc.tasks.a.spent, 0);
});

test('добавление времени к просроченной задаче считается от текущего момента', () => {
  const doc = makeDoc([{ id: 'a', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '11:00');
  extendTask(doc, 'a', 60, now);
  assert.equal(computePlan(doc, now).items[0].end, at('2026-11-02', '12:00'));
});

test('повторный старт: работа ещё не начиналась, считаем с этого момента', () => {
  const doc = makeDoc([{ id: 'a', dur: 60, lag: 30 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '10:00');
  restartFirst(doc, now);
  const [a] = computePlan(doc, now).items;
  assert.equal(a.start, now);
  assert.equal(a.end, at('2026-11-02', '11:00'));
});

test('удаление первой задачи запускает следующую сейчас', () => {
  const doc = makeDoc([{ id: 'a', dur: 60 }, { id: 'b', dur: 60 }], { anchor: at('2026-11-02', '09:00') });
  const now = at('2026-11-02', '09:30');
  deleteTask(doc, 'a', now);
  const [b] = computePlan(doc, now).items;
  assert.equal(b.id, 'b');
  assert.equal(b.start, now);
});

test('дедлайн: считаем опоздание и находим место, где ничего не срывается', () => {
  const now = at('2026-11-02', '09:00');
  const doc = makeDoc(
    [
      { id: 'a', dur: 120 },
      { id: 'b', dur: 120, deadline: at('2026-11-02', '14:00') },
      { id: 'c', dur: 240 },
    ],
    { anchor: now },
  );
  const base = computePlan(doc, now);
  assert.equal(base.byId.get('b').late, 0);

  const apply = (index) => (draft, t) => {
    draft.tasks.n = { ...createTask({}, t), id: 'n', dur: 180, deadline: at('2026-11-02', '17:00') };
    placeTask(draft, 'n', { kind: 'index', index }, t);
    return 'n';
  };

  const first = simulate(doc, now, apply(0));
  const impact = impactOf(base, first.plan, 'n');
  assert.deepEqual(impact.newlyLate.map((t) => t.id), ['b'], 'вставка в начало срывает дедлайн b');
  assert.equal(impact.moved, 3);

  const best = suggestIndex(doc, now, 3, (draft, index, t) => apply(index)(draft, t));
  assert.equal(best, 2, 'после b и не позже чем успевает сама');
});

test('нет рабочих дней: план не зависает и сообщает об этом', () => {
  const week = defaultWeek();
  for (const day of Object.keys(week)) week[day].on = false;
  const doc = makeDoc([{ id: 'a', dur: 60 }], { anchor: at('2026-11-02', '09:00'), week });
  const plan = computePlan(doc, at('2026-11-02', '09:00'));
  assert.equal(plan.stuck, true);
  assert.equal(plan.items.length, 0);
});

test('конец дня для нужного числа часов учитывает перерывы', () => {
  const breaks = [{ start: '13:00', end: '14:00' }];
  assert.equal(endForMinutes(12 * 60, breaks, 7 * 60), 20 * 60);
  assert.equal(endForMinutes(17 * 60, breaks, 2 * 60), 19 * 60);
});

test('разбор длительности понимает разные записи', () => {
  assert.equal(parseDur('2'), 120);
  assert.equal(parseDur('1,5'), 90);
  assert.equal(parseDur('2:30'), 150);
  assert.equal(parseDur('2ч 30м'), 150);
  assert.equal(parseDur('45 мин'), 45);
  assert.equal(parseDur('3 часа'), 180);
  assert.equal(parseDur('нет'), null);
  assert.equal(fmtDur(150), '2 ч 30 мин');
  assert.equal(fmtDur(45), '45 мин');
  assert.equal(fmtDur(120), '2 ч');
});
