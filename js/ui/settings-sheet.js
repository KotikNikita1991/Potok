// Настройки: обычная неделя, праздники, синхронизация, тема, резервная копия.

import { workMinutes } from '../core/calendar.js';
import { canon, clone, isValidDoc, normalize } from '../core/doc.js';
import { DAYS_FULL, fmtDur, fmtMoment } from '../core/format.js';
import { h, icon } from './dom.js';
import { breaksEditor } from './day-sheet.js';
import { readStorage, writeStorage } from './store.js';
import { toast } from './overlays.js';
import { openSheet } from './sheet.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=%D0%9F%D0%BE%D1%82%D0%BE%D0%BA';

export function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') root.dataset.theme = value;
  else delete root.dataset.theme;
}

export function initTheme() {
  applyTheme(readStorage('potok.theme'));
}

function weekSection(ctx) {
  const { store } = ctx;
  const save = (weekday, value) => {
    store.commit((draft) => {
      draft.settings.week[weekday] = value;
    }, { coalesce: 'settings' });
  };

  const rows = h('div', { class: 'week' });
  const render = () => {
    const week = clone(store.doc.settings.week);
    rows.replaceChildren(...WEEK_ORDER.map((weekday) => {
      const day = week[weekday];
      const toggle = h('input', {
        id: `week-on-${weekday}`,
        type: 'checkbox',
        checked: day.on,
        'aria-label': DAYS_FULL[weekday],
        onchange: () => {
          day.on = toggle.checked;
          save(weekday, day);
          render();
        },
      });
      const start = h('input', {
        id: `week-start-${weekday}`,
        class: 'input input-time',
        type: 'time',
        step: 300,
        value: day.start,
        disabled: !day.on,
        'aria-label': `Начало, ${DAYS_FULL[weekday]}`,
        onchange: () => {
          if (!start.value) return;
          day.start = start.value;
          save(weekday, day);
          updateSum();
        },
      });
      const end = h('input', {
        id: `week-end-${weekday}`,
        class: 'input input-time',
        type: 'time',
        step: 300,
        value: day.end,
        disabled: !day.on,
        'aria-label': `Конец, ${DAYS_FULL[weekday]}`,
        onchange: () => {
          if (!end.value) return;
          day.end = end.value;
          save(weekday, day);
          updateSum();
        },
      });
      const sum = h('span', { class: 'week-sum' });
      const updateSum = () => {
        sum.textContent = day.on ? fmtDur(workMinutes(day)) : 'выходной';
      };
      updateSum();

      const breaksCount = h('span');
      const updateBreaks = () => {
        const n = day.breaks.length;
        breaksCount.textContent = n ? `Перерывы: ${n}` : 'Без перерывов';
      };
      updateBreaks();

      const details = h('div', { class: 'week-breaks', hidden: true }, breaksEditor(day.breaks, () => {
        save(weekday, day);
        updateSum();
        updateBreaks();
      }));
      const expand = h('button', {
        class: 'btn btn-small btn-ghost',
        type: 'button',
        disabled: !day.on,
        onclick: () => {
          details.hidden = !details.hidden;
        },
      }, breaksCount);

      return h('div', { class: `week-row${day.on ? '' : ' is-off'}` },
        h('label', { class: 'switch', for: `week-on-${weekday}` }, toggle, h('i')),
        h('span', { class: 'week-name' }, DAYS_FULL[weekday]),
        h('span', { class: 'week-times' }, start, h('span', { class: 'dash' }, '–'), end),
        sum,
        expand,
        details);
    }));
  };
  render();

  return h('section', { class: 'set-section', id: 'set-week' },
    h('h3', null, 'Обычная неделя'),
    h('p', { class: 'set-note' }, 'Отдельный день настраивается нажатием на его заголовок на графике.'),
    rows,
    h('button', {
      class: 'btn btn-small',
      type: 'button',
      onclick: () => {
        store.commit((draft) => {
          const monday = draft.settings.week[1];
          for (const weekday of [2, 3, 4, 5]) draft.settings.week[weekday] = clone(monday);
        }, { coalesce: 'settings' });
        render();
        toast('Понедельник скопирован на будни', { action: { label: 'Отменить', run: () => { store.undo(); render(); } } });
      },
    }, 'Как в понедельник для всех будней'));
}

function calendarSection(ctx) {
  const { store } = ctx;
  const toggle = h('input', {
    id: 'set-holidays',
    type: 'checkbox',
    checked: store.doc.settings.holidays,
    onchange: () => {
      store.commit((draft) => {
        draft.settings.holidays = toggle.checked;
      }, { coalesce: 'settings' });
    },
  });
  return h('section', { class: 'set-section' },
    h('h3', null, 'Календарь'),
    h('label', { class: 'switch-row', for: 'set-holidays' },
      h('span', { class: 'switch-text' },
        'Праздники РФ',
        h('span', { class: 'field-hint' }, 'Праздники и переносы по производственному календарю. Сокращённые предпраздничные дни не учитываются.')),
      h('span', { class: 'switch' }, toggle, h('i'))));
}

function syncSection(ctx, onRender) {
  const { sync } = ctx;
  const box = h('section', { class: 'set-section', id: 'set-sync' });
  let tokenDraft = '';

  const render = () => {
    const { status } = sync;
    if (!sync.connected) {
      const busy = status.state === 'busy';
      const input = h('input', {
        id: 'sync-token',
        class: 'input',
        type: 'password',
        autocomplete: 'off',
        spellcheck: false,
        placeholder: 'Токен, начинается с ghp_',
        'aria-label': 'Токен GitHub',
        value: tokenDraft,
        oninput: () => {
          tokenDraft = input.value;
        },
      });
      const connect = h('button', {
        class: 'btn btn-primary',
        type: 'button',
        disabled: busy,
        onclick: async () => {
          if (!tokenDraft.trim()) {
            input.focus();
            return;
          }
          try {
            await sync.connect(tokenDraft);
            tokenDraft = '';
            toast('Синхронизация подключена');
          } catch {
            // текст ошибки показан в этом же разделе
          }
          render();
        },
      }, busy ? 'Подключаю…' : 'Подключить');
      box.replaceChildren(
        h('h3', null, 'Синхронизация'),
        h('p', { class: 'set-note' }, 'Чтобы на телефоне и компьютере были одни и те же задачи, данные хранятся в секретном Gist на GitHub. Токен остаётся только на этом устройстве.'),
        h('ol', { class: 'set-steps' },
          h('li', null, h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Откройте страницу создания токена'), ' на GitHub. Нужное разрешение gist уже выбрано.'),
          h('li', null, 'В поле Expiration выберите No expiration и нажмите Generate token.'),
          h('li', null, 'Скопируйте токен и вставьте сюда. На втором устройстве вставьте тот же токен.')),
        h('div', { class: 'link-row' }, input, connect),
        status.message ? h('div', { class: 'impact-warn' }, icon('warn', 15), status.message) : '',
      );
      return;
    }

    const last = status.lastSync ? fmtMoment(status.lastSync, Date.now()) : 'ещё не было';
    const stateText = {
      busy: 'Синхронизирую…',
      idle: `Всё сохранено. Последний раз ${last}`,
      offline: status.message,
      error: status.message,
    }[status.state] ?? '';
    box.replaceChildren(
      h('h3', null, 'Синхронизация'),
      h('div', { class: `sync-state is-${status.state}` },
        icon(status.state === 'idle' ? 'cloudCheck' : status.state === 'busy' ? 'sync' : 'cloudOff'),
        h('span', null, stateText)),
      h('p', { class: 'set-note' }, `Аккаунт GitHub: ${sync.config.login}.`),
      h('div', { class: 'set-actions' },
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => sync.syncNow() }, icon('sync', 15), 'Синхронизировать'),
        h('button', {
          class: 'btn btn-small btn-ghost',
          type: 'button',
          onclick: () => {
            sync.disconnect();
            toast('Синхронизация отключена на этом устройстве. Данные остались здесь и в Gist.');
          },
        }, 'Отключить на этом устройстве')),
    );
  };
  render();
  onRender(render);
  return box;
}

function appearanceSection() {
  const current = readStorage('potok.theme') || 'auto';
  const select = h('select', {
    id: 'set-theme',
    class: 'input',
    onchange: () => {
      writeStorage('potok.theme', select.value);
      applyTheme(select.value);
    },
  },
  h('option', { value: 'auto' }, 'Как в системе'),
  h('option', { value: 'light' }, 'Светлая'),
  h('option', { value: 'dark' }, 'Тёмная'));
  select.value = current;
  return h('section', { class: 'set-section' },
    h('h3', null, 'Оформление'),
    h('label', { class: 'field', for: 'set-theme' }, h('span', { class: 'field-label' }, 'Тема'), select));
}

function installSection() {
  return h('section', { class: 'set-section' },
    h('h3', null, 'Приложение на iPhone'),
    h('ol', { class: 'set-steps' },
      h('li', null, 'Откройте эту страницу в Safari.'),
      h('li', null, 'Нажмите «Поделиться», затем «На экран „Домой“».'),
      h('li', null, 'Откройте «Поток» с новой иконки и подключите синхронизацию в настройках.')));
}

function dataSection(ctx) {
  const { store } = ctx;
  const file = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const [picked] = file.files;
      if (!picked) return;
      try {
        const doc = JSON.parse(await picked.text());
        if (!isValidDoc(doc)) throw new Error('invalid');
        store.replaceAll(normalize(doc));
        toast('Данные загружены из файла', { action: { label: 'Отменить', run: () => store.undo() } });
      } catch {
        toast('Этот файл не похож на копию данных «Потока»');
      }
      file.value = '';
    },
  });
  return h('section', { class: 'set-section' },
    h('h3', null, 'Резервная копия'),
    h('p', { class: 'set-note' }, 'Все задачи и настройки в одном файле. Загрузка из файла заменит текущие данные, это можно отменить.'),
    h('div', { class: 'set-actions' },
      h('button', {
        class: 'btn btn-small',
        type: 'button',
        onclick: () => {
          const blob = new Blob([canon(store.doc)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = h('a', { href: url, download: `potok-${new Date(store.now()).toISOString().slice(0, 10)}.json` });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        },
      }, 'Скачать копию'),
      h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => file.click() }, 'Загрузить из файла'),
      file));
}

export function openSettingsSheet(ctx, focus = null) {
  let rerenderSync = () => {};
  const content = h('div', { class: 'settings-grid' },
    h('div', { class: 'sheet-col' }, weekSection(ctx), calendarSection(ctx)),
    h('div', { class: 'sheet-col' },
      syncSection(ctx, (fn) => {
        rerenderSync = fn;
      }),
      installSection(),
      appearanceSection(),
      dataSection(ctx)));

  openSheet(ctx, {
    title: 'Настройки',
    name: 'settings',
    content,
    cancelLabel: null,
    primaryLabel: 'Готово',
    onPrimary: () => ctx.closeSheet(),
    onClose: () => {
      ctx.store.lastCoalesce = null;
      ctx.settingsRefresh = null;
    },
  });
  ctx.settingsRefresh = () => rerenderSync();
  if (focus === 'sync') document.getElementById('set-sync')?.scrollIntoView({ block: 'start' });
}
