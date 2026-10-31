// Примеры для первого запуска: показывают, как выглядит живой план.

import { calendarOf, dayPlan, workSpans } from './calendar.js';
import { createDoc, createTask } from './doc.js';
import { computePlan } from './plan.js';
import { atKey, shiftKey, toKey } from './time.js';

function nextWorkdays(doc, now, count) {
  const calendar = calendarOf(doc);
  const out = [];
  let key = toKey(now);
  for (let i = 0; i < 60 && out.length < count; i += 1) {
    if (workSpans(dayPlan(key, calendar)).length) out.push(key);
    key = shiftKey(key, 1);
  }
  return out;
}

export function sampleDoc(now) {
  const doc = createDoc();
  doc.meta.sample = true;
  doc.plan.anchor = now;

  const add = (fields) => {
    const task = createTask({ sample: true, status: 'queue', ...fields }, now);
    doc.tasks[task.id] = task;
    if (task.status === 'queue' && task.pinAt == null) doc.plan.order.push(task.id);
    return task;
  };

  add({ title: 'Подготовить отчёт за месяц', note: 'Собрать цифры и свести в таблицу', dur: 180, color: 'sky' });
  add({ title: 'Обновить презентацию', note: 'Новые цифры и два слайда про планы', dur: 180, lag: 60, color: 'lav' });
  const big = add({ title: 'Разобрать правки заказчика', note: 'Пройти весь список замечаний, сверить с договором', dur: 600, lag: 60, color: 'coral' });
  add({ title: 'Написать письмо партнёрам', dur: 90, color: 'mint' });
  add({ title: 'Обновить шаблон договора', note: 'Когда появится свободное окно', dur: 120, color: 'sun', status: 'backlog' });

  const days = nextWorkdays(doc, now, 3);
  if (days[1]) add({ title: 'Созвон с заказчиком', dur: 60, color: 'rose', pinAt: atKey(days[1], 15 * 60) });

  const plan = computePlan(doc, now);
  const end = plan.byId.get(big.id)?.end;
  if (end) big.deadline = atKey(shiftKey(toKey(end), 1), 18 * 60);
  return doc;
}
