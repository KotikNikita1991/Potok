// Верхняя карточка: что происходит прямо сейчас и что с этим сделать.

import { fmtDur, fmtMoment, fmtShort } from '../core/format.js';
import { toKey } from '../core/time.js';
import { h, icon, safeLink } from './dom.js';
import { addTime, finishTask, moveTask, openFinishedAtMenu, restart } from './actions.js';
import { menuItem, openMenu } from './overlays.js';

export class NowBar {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.el = h('div', { class: 'now' });
    root.append(this.el);
  }

  update({ plan, now }) {
    const { ctx } = this;
    const first = plan.items[0];

    if (plan.stuck) {
      this.render('warn', 'Нет рабочего времени', 'В расписании не осталось рабочих дней. Откройте настройки и включите их.', null, [
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => ctx.openSettings() }, 'Настройки'),
      ]);
      return;
    }

    if (!first) {
      this.render('idle', 'Очередь пуста', 'Добавьте задачу, и здесь появится, что делать дальше.', null, []);
      return;
    }

    const done = h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => finishTask(ctx, first.id) }, icon('check', 16), 'Готово');

    if (first.isOverdue) {
      this.render(
        'late',
        'Срок прошёл',
        `План был до ${fmtMoment(first.plannedEnd, now)}, следующие задачи уже сдвигаются.`,
        first,
        [
          done,
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => finishTask(ctx, first.id, first.plannedEnd) }, `Завершено в ${fmtShort(first.plannedEnd, now)}`),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => addTime(ctx, first.id, 30) }, '+30 мин'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => addTime(ctx, first.id, 60) }, '+1 ч'),
        ],
      );
      return;
    }

    if (first.isCurrent) {
      const working = plan.clock.isWorking(now);
      const resume = plan.clock.next(now);
      const detail = working
        ? `Осталось ${fmtDur(first.remainingMin)}, закончится ${fmtMoment(first.end, now)}`
        : `Продолжится ${fmtMoment(resume, now)}, закончится ${fmtMoment(first.end, now)}`;
      const label = working ? 'Сейчас' : toKey(resume) === toKey(now) ? 'Перерыв' : 'Нерабочее время';
      this.render(working ? 'running' : 'paused', label, detail, first, [done, this.moreButton(first)]);
      return;
    }

    this.render(
      'next',
      'Дальше',
      `Начнётся ${fmtMoment(first.start, now)}, закончится ${fmtMoment(first.end, now)}`,
      first,
      [
        plan.clock.isWorking(now)
          ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => moveTask(ctx, first.id, { kind: 'now' }) }, icon('play', 14), 'Начать')
          : null,
        this.moreButton(first),
      ],
    );
  }

  moreButton(item) {
    const { ctx } = this;
    const button = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Ещё действия',
      'aria-label': 'Ещё действия',
      onclick: () => {
        openMenu(button, [
          menuItem({ iconName: 'clock', label: '+30 минут', run: () => addTime(ctx, item.id, 30) }),
          menuItem({ iconName: 'clock', label: '+1 час', run: () => addTime(ctx, item.id, 60) }),
          item.isCurrent
            ? menuItem({ iconName: 'play', label: 'Ещё не начато', hint: 'считать время с этого момента', run: () => restart(ctx) })
            : null,
          item.isCurrent
            ? menuItem({ iconName: 'check', label: 'Закончилось раньше…', run: () => openFinishedAtMenu(ctx, button, item.id) })
            : null,
        ]);
      },
    }, icon('dots'));
    return button;
  }

  render(state, label, detail, item, actions) {
    const { ctx } = this;
    const task = item?.task;
    const link = safeLink(task?.link);
    const total = item ? item.elapsedMin + item.remainingMin : 0;
    const progress = item?.isCurrent && total ? Math.min(1, item.elapsedMin / total) : 0;
    this.el.className = `now is-${state}`;
    this.el.replaceChildren(
      h(
        'div',
        { class: 'now-main' },
        h('div', { class: 'now-line' },
          h('span', { class: 'now-label' }, label),
          task
            ? h('button', { class: `now-title c-${task.color}`, type: 'button', onclick: () => ctx.openTask(task.id) },
              h('i', { class: 'dot' }),
              h('span', null, task.title || 'Без названия'))
            : null,
          link
            ? h('a', { class: 'icon-btn icon-btn-small', href: link, target: '_blank', rel: 'noopener noreferrer', title: 'Открыть ссылку', 'aria-label': 'Открыть ссылку' }, icon('external', 15))
            : null),
        h('div', { class: 'now-detail' }, detail),
        progress ? h('div', { class: 'now-progress' }, h('i', { style: { width: `${progress * 100}%` } })) : null,
      ),
      actions.length ? h('div', { class: 'now-actions' }, actions) : '',
    );
  }
}
