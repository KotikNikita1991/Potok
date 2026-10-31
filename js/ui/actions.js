// Действия с задачами, общие для списка, графика и карточек.

import { fmtDur, fmtMoment, fmtTime } from '../core/format.js';
import { completeTask, extendTask, placeTask, restartFirst } from '../core/ops.js';
import { atKey, toKey } from '../core/time.js';
import { h } from './dom.js';
import { closeMenu, menuItem, openMenu, toast } from './overlays.js';

const undoAction = (ctx) => ({ label: 'Отменить', run: () => ctx.store.undo() });

export function moveTask(ctx, id, placement) {
  const { store } = ctx;
  store.commit((draft, now) => placeTask(draft, id, placement, now));
  const { plan, now, doc } = store.base();
  const item = plan.byId.get(id);
  const title = doc.tasks[id].title;
  if (placement.kind === 'backlog') {
    toast(`«${title}» убрана с графика`, { action: undoAction(ctx) });
    return;
  }
  if (item) {
    toast(`«${title}» начнётся ${fmtMoment(item.start, now)}, закончится ${fmtMoment(item.end, now)}`, { action: undoAction(ctx) });
    ctx.timeline.revealTask(id);
  }
}

export function finishTask(ctx, id, at) {
  const { store } = ctx;
  const title = store.doc.tasks[id].title;
  store.commit((draft, now) => completeTask(draft, id, now, at ?? now));
  const { plan, now } = store.base();
  const next = plan.items[0];
  const tail = next ? ` Дальше: «${next.task.title}», закончится ${fmtMoment(next.end, now)}` : '';
  toast(`«${title}» готово.${tail}`, { action: undoAction(ctx), timeout: 8000 });
}

export function addTime(ctx, id, minutes) {
  ctx.store.commit((draft, now) => extendTask(draft, id, minutes, now));
  const { plan, now, doc } = ctx.store.base();
  const item = plan.byId.get(id);
  if (item) {
    toast(`+${fmtDur(minutes)} к «${doc.tasks[id].title}», закончится ${fmtMoment(item.end, now)}`, { action: undoAction(ctx) });
  }
}

export function restart(ctx) {
  const { store } = ctx;
  store.commit((draft, now) => restartFirst(draft, now));
  const { plan, now } = store.base();
  const first = plan.items[0];
  if (first) toast(`Отсчёт идёт с этого момента, закончится ${fmtMoment(first.end, now)}`, { action: undoAction(ctx) });
}

export function toLocalInput(t) {
  const d = new Date(t);
  return `${toKey(t)}T${fmtTime(d.getTime())}`;
}

// Меню «Перенести»: быстрый способ поднять задачу из любого места списка.
export function openMoveMenu(ctx, anchor, id) {
  const { store } = ctx;
  const { doc, plan, now } = store.base();
  const task = doc.tasks[id];
  const first = plan.items[0];
  const inQueue = doc.plan.order.includes(id);
  const others = doc.plan.order.filter((x) => x !== id);
  const items = [];

  if (first?.id !== id) {
    items.push(menuItem({
      iconName: 'play',
      label: first?.isCurrent ? 'Начать сейчас' : 'Поставить первой',
      hint: first?.isCurrent ? `«${first.task.title}» прервётся, остаток уйдёт после` : null,
      run: () => moveTask(ctx, id, { kind: 'now' }),
    }));
  }
  if (others.length && doc.plan.order[1] !== id) {
    items.push(menuItem({
      iconName: 'next',
      label: 'Следующей',
      hint: first?.id !== id ? `после «${doc.tasks[others[0]].title}»` : null,
      run: () => moveTask(ctx, id, { kind: 'next' }),
    }));
  }
  if (doc.plan.order[doc.plan.order.length - 1] !== id) {
    items.push(menuItem({ iconName: 'down', label: others.length ? 'В конец очереди' : 'На график', run: () => moveTask(ctx, id, { kind: 'end' }) }));
  }

  const dateInput = h('input', { type: 'date', class: 'menu-date', value: toKey(now), 'aria-label': 'Дата' });
  const dateRow = h(
    'div',
    { class: 'menu-row' },
    dateInput,
    h('button', {
      class: 'btn btn-small',
      type: 'button',
      onclick: () => {
        if (!dateInput.value) return;
        closeMenu();
        moveTask(ctx, id, { kind: 'moment', at: atKey(dateInput.value, 0) });
      },
    }, 'На дату'),
  );
  items.push(dateRow);

  if (inQueue || task.pinAt != null) {
    items.push(menuItem({ iconName: 'inbox', label: 'Убрать с графика', hint: 'останется в списке без даты', run: () => moveTask(ctx, id, { kind: 'backlog' }) }));
  }
  if (task.status !== 'done') {
    items.push(menuItem({ iconName: 'check', label: 'Готово', run: () => finishTask(ctx, id) }));
  }
  openMenu(anchor, items, { label: `Перенести «${task.title}»` });
}

// Завершение задним числом: работа закончилась раньше, чем об этом отметили.
export function openFinishedAtMenu(ctx, anchor, id) {
  const { now, plan } = ctx.store.base();
  const item = plan.byId.get(id);
  const input = h('input', {
    type: 'datetime-local',
    class: 'menu-date',
    value: toLocalInput(now),
    max: toLocalInput(now),
    min: item ? toLocalInput(item.start) : null,
    'aria-label': 'Когда закончилась работа',
  });
  openMenu(anchor, [
    h('div', { class: 'menu-title' }, 'Когда закончилась работа?'),
    h('div', { class: 'menu-row' }, input, h('button', {
      class: 'btn btn-small btn-primary',
      type: 'button',
      onclick: () => {
        const at = new Date(input.value).getTime();
        if (Number.isNaN(at)) return;
        closeMenu();
        finishTask(ctx, id, at);
      },
    }, 'Готово')),
  ]);
}
