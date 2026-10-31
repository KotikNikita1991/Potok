// Настройка одного дня: своё начало, конец и перерывы. Обычная неделя при этом не меняется.

import { calendarOf, dayPlan, endForMinutes, workMinutes } from '../core/calendar.js';
import { fmtDayTitle, fmtDur } from '../core/format.js';
import { formatHM, minutesOfDay, parseHM, roundTo, shiftKey, toKey, weekdayOf } from '../core/time.js';
import { h, icon } from './dom.js';
import { openSheet } from './sheet.js';

// Редактор списка перерывов; используется и для дня, и для обычной недели.
export function breaksEditor(breaks, onChange) {
  const list = h('div', { class: 'breaks' });
  const render = () => {
    list.replaceChildren(
      ...breaks.map((pause, index) => {
        const label = h('input', {
          class: 'input',
          type: 'text',
          value: pause.label ?? '',
          placeholder: 'Перерыв',
          'aria-label': 'Название перерыва',
          onchange: () => {
            pause.label = label.value.trim();
            onChange(breaks);
          },
        });
        const start = h('input', {
          class: 'input',
          type: 'time',
          step: 300,
          value: pause.start,
          'aria-label': 'Начало перерыва',
          onchange: () => {
            if (!start.value) return;
            pause.start = start.value;
            onChange(breaks);
          },
        });
        const end = h('input', {
          class: 'input',
          type: 'time',
          step: 300,
          value: pause.end,
          'aria-label': 'Конец перерыва',
          onchange: () => {
            if (!end.value) return;
            pause.end = end.value;
            onChange(breaks);
          },
        });
        return h('div', { class: 'break-row' }, label, start, h('span', { class: 'dash' }, '–'), end, h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Убрать перерыв',
          'aria-label': 'Убрать перерыв',
          onclick: () => {
            breaks.splice(index, 1);
            onChange(breaks);
            render();
          },
        }, icon('close', 16)));
      }),
      h('button', {
        class: 'btn btn-small btn-add',
        type: 'button',
        onclick: () => {
          const last = breaks[breaks.length - 1];
          const from = last ? parseHM(last.end) + 60 : 15 * 60;
          breaks.push({ start: formatHM(Math.min(from, 22 * 60)), end: formatHM(Math.min(from + 15, 23 * 60)), label: 'Перерыв' });
          onChange(breaks);
          render();
        },
      }, icon('plus', 15), 'Добавить перерыв'),
    );
  };
  render();
  return list;
}

function usualFor(key, doc) {
  return doc.settings.week[weekdayOf(key)];
}

export function openDaySheet(ctx, initialKey) {
  const { store } = ctx;
  let key = initialKey;

  const titleText = h('span', { class: 'day-nav-title' });
  const titleEl = h('div', { class: 'day-nav' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Предыдущий день', onclick: () => go(-1) }, icon('left')),
    titleText,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Следующий день', onclick: () => go(1) }, icon('right')));

  const body = h('div', { class: 'day-form' });

  const save = (next) => {
    store.commit((draft) => {
      draft.days[key] = { on: next.on, start: next.start, end: next.end, breaks: next.breaks };
    }, { coalesce: `day:${key}` });
  };

  const go = (delta) => {
    key = shiftKey(key, delta);
    render();
  };

  function render() {
    const { doc, now } = store.base();
    const plan = dayPlan(key, calendarOf(doc));
    const state = { on: plan.on, start: plan.start, end: plan.end, breaks: (plan.breaks ?? []).map((b) => ({ ...b })) };
    const isToday = key === toKey(now);
    const usual = usualFor(key, doc);
    const usualMinutes = workMinutes(usual.on ? usual : doc.settings.week[1]);

    titleText.textContent = fmtDayTitle(key) + (isToday ? ', сегодня' : '');

    const apply = () => {
      save(state);
      renderSummary();
    };

    const onToggle = h('input', {
      id: 'day-on',
      type: 'checkbox',
      checked: state.on,
      onchange: () => {
        state.on = onToggle.checked;
        fields.hidden = !state.on;
        apply();
      },
    });

    const startInput = h('input', {
      id: 'day-start',
      class: 'input input-time',
      type: 'time',
      step: 300,
      value: state.start,
      onchange: () => {
        if (!startInput.value) return;
        state.start = startInput.value;
        apply();
      },
    });
    const endInput = h('input', {
      id: 'day-end',
      class: 'input input-time',
      type: 'time',
      step: 300,
      value: state.end,
      onchange: () => {
        if (!endInput.value) return;
        state.end = endInput.value;
        apply();
      },
    });

    const summary = h('div', { class: 'day-summary' });
    const renderSummary = () => {
      const minutes = workMinutes(state);
      summary.replaceChildren();
      if (!state.on) {
        summary.append('Выходной: задачи этот день обходят.');
        return;
      }
      if (parseHM(state.end) <= parseHM(state.start)) {
        summary.append(h('span', { class: 'text-warn' }, 'Конец дня должен быть позже начала.'));
        return;
      }
      summary.append(h('span', null, 'Рабочих часов: ', h('b', null, fmtDur(minutes))));
      if (minutes !== usualMinutes) {
        const end = endForMinutes(parseHM(state.start), state.breaks, usualMinutes);
        if (end < 24 * 60) {
          summary.append(h('button', {
            class: 'btn btn-small',
            type: 'button',
            onclick: () => {
              state.end = formatHM(end);
              endInput.value = state.end;
              apply();
            },
          }, `Сохранить обычные ${fmtDur(usualMinutes)}: до ${formatHM(end)}`));
        }
      }
    };

    const breaks = breaksEditor(state.breaks, () => apply());

    const quick = [];
    if (isToday) {
      const current = roundTo(minutesOfDay(now), 5);
      quick.push(
        h('button', {
          class: 'chip',
          type: 'button',
          onclick: () => {
            state.on = true;
            state.start = formatHM(current);
            startInput.value = state.start;
            onToggle.checked = true;
            fields.hidden = false;
            apply();
          },
        }, 'Начинаю сейчас'),
        h('button', {
          class: 'chip',
          type: 'button',
          onclick: () => {
            state.end = formatHM(current);
            endInput.value = state.end;
            apply();
          },
        }, 'Заканчиваю сейчас'),
      );
    }

    const fields = h('div', { class: 'day-fields', hidden: !state.on },
      h('div', { class: 'time-pair' },
        h('label', { class: 'field', for: 'day-start' }, h('span', { class: 'field-label' }, 'Начало'), startInput),
        h('label', { class: 'field', for: 'day-end' }, h('span', { class: 'field-label' }, 'Конец'), endInput)),
      quick.length ? h('div', { class: 'chips' }, quick) : null,
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Перерывы'), breaks));

    const isCustom = plan.source === 'custom';
    const note = plan.holiday
      ? h('div', { class: 'status' }, h('b', null, plan.holiday), isCustom ? '. Этот день вы настроили отдельно.' : '. Нерабочий день по календарю РФ, но его можно сделать рабочим.')
      : plan.source === 'transfer'
        ? h('div', { class: 'status' }, h('b', null, 'Рабочая суббота'), ' по производственному календарю РФ.')
        : isCustom
          ? h('div', { class: 'status' }, 'Этот день настроен отдельно от обычной недели.')
          : null;

    body.replaceChildren(
      note ?? '',
      h('label', { class: 'switch-row', for: 'day-on' },
        h('span', { class: 'switch-text' }, 'Рабочий день'),
        h('span', { class: 'switch' }, onToggle, h('i'))),
      fields,
      summary,
      isCustom
        ? h('button', {
          class: 'btn btn-reset',
          type: 'button',
          onclick: () => {
            store.commit((draft) => {
              draft.days[key] = { removed: true };
            }, { coalesce: `day:${key}` });
            render();
          },
        }, icon('undo', 16), 'Вернуть как обычно')
        : '',
    );
    renderSummary();
  }

  render();
  openSheet(ctx, {
    title: 'Настройка дня',
    titleEl,
    name: 'day',
    content: body,
    cancelLabel: null,
    primaryLabel: 'Готово',
    onPrimary: () => ctx.closeSheet(),
    onClose: () => {
      store.lastCoalesce = null;
    },
  });
}
