// Горизонтальный график: дни и часы сверху, одна линия задач, под ней вехи окончания.

import { calendarOf, dayPlan, workMinutes, workSpans } from '../core/calendar.js';
import { clone } from '../core/doc.js';
import { DAYS, fmtDur, fmtMoment, fmtShort, fmtTime } from '../core/format.js';
import { placeTask, setRemaining } from '../core/ops.js';
import { STEP, atKey, clamp, minutesOfDay, parseHM, roundTo, shiftKey, toKey } from '../core/time.js';
import { h, icon, isTouch, prefersReducedMotion } from './dom.js';
import { store, readStorage, writeStorage } from './store.js';
import { toast } from './overlays.js';

const ZOOMS = [12, 20, 32, 48, 72, 104];
const OFF_WIDTH = 30;
const ZOOM_KEY = 'potok.zoom';
const LIFT_DISTANCE = 22; // на сколько вытащить задачу из линии, чтобы менять порядок
const LONG_PRESS = 320;

class Axis {
  constructor(blocks, total, hourPx, byKey, from, to) {
    Object.assign(this, { blocks, total, hourPx, byKey, from, to });
  }

  x(t) {
    const key = toKey(t);
    if (key < this.from) return 0;
    if (key > this.to) return this.total;
    const block = this.byKey.get(key);
    if (block.type === 'off') {
      const index = block.keys.indexOf(key);
      return block.x + ((index + minutesOfDay(t) / 1440) / block.keys.length) * block.w;
    }
    return block.x + ((clamp(minutesOfDay(t), block.vs, block.ve) - block.vs) / 60) * this.hourPx;
  }

  timeAt(x) {
    const { blocks } = this;
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (blocks[mid].x <= x) lo = mid;
      else hi = mid - 1;
    }
    const block = blocks[lo];
    if (block.type === 'off') {
      const position = clamp((x - block.x) / block.w, 0, 0.999) * block.keys.length;
      const index = Math.floor(position);
      return atKey(block.keys[index], Math.round((position - index) * 1440));
    }
    const minutes = block.vs + ((x - block.x) / this.hourPx) * 60;
    return atKey(block.key, clamp(roundTo(minutes), block.vs, block.ve));
  }
}

function buildAxis({ calendar, from, to, hourPx, extents }) {
  const blocks = [];
  const byKey = new Map();
  let x = 0;
  for (let key = from; key <= to; key = shiftKey(key, 1)) {
    const plan = dayPlan(key, calendar);
    const spans = workSpans(plan);
    const extent = extents.get(key);
    let a = spans.length ? spans[0][0] : null;
    let b = spans.length ? spans[spans.length - 1][1] : null;
    if (extent) {
      a = a == null ? extent[0] : Math.min(a, extent[0]);
      b = b == null ? extent[1] : Math.max(b, extent[1]);
    }
    if (a == null) {
      let off = blocks[blocks.length - 1];
      if (off?.type !== 'off') {
        off = { type: 'off', keys: [], plans: [], x, w: OFF_WIDTH };
        blocks.push(off);
        x += OFF_WIDTH;
      }
      off.keys.push(key);
      off.plans.push(plan);
      byKey.set(key, off);
    } else {
      const vs = Math.floor(a / 60) * 60;
      const ve = Math.ceil(b / 60) * 60;
      const w = ((ve - vs) / 60) * hourPx;
      const block = { type: 'day', key, x, w, vs, ve, plan, spans };
      blocks.push(block);
      byKey.set(key, block);
      x += w;
    }
  }
  return new Axis(blocks, x, hourPx, byKey, from, to);
}

function collectExtents(plan, doc) {
  const extents = new Map();
  const add = (s, e) => {
    const key = toKey(s);
    const a = minutesOfDay(s);
    const b = toKey(e) === key ? minutesOfDay(e) : 1440;
    const known = extents.get(key);
    extents.set(key, known ? [Math.min(known[0], a), Math.max(known[1], b)] : [a, b]);
  };
  for (const item of plan.pinned) add(item.start, item.end);
  for (const task of Object.values(doc.tasks)) {
    if (task.deleted) continue;
    for (const [s, e] of task.history ?? []) add(s, e);
  }
  return extents;
}

function offLabel(block) {
  const first = block.keys[0];
  const last = block.keys[block.keys.length - 1];
  const dayOf = (key) => DAYS[new Date(atKey(key)).getDay()];
  const holiday = block.plans.find((p) => p.holiday)?.holiday;
  if (holiday) return holiday;
  return block.keys.length > 1 ? `${dayOf(first)}–${dayOf(last)}` : dayOf(first);
}

export class Timeline {
  constructor(root, handlers) {
    this.handlers = handlers;
    const saved = Number(readStorage(ZOOM_KEY));
    this.zoom = ZOOMS.includes(saved) ? ZOOMS.indexOf(saved) : isTouch() ? 3 : 4;
    this.range = null;
    this.signature = null;
    this.prevLefts = new Map();
    this.press = null;
    this.drag = null;
    this.suppressClick = false;

    this.daysEl = h('div', { class: 'tl-days' });
    this.hoursEl = h('div', { class: 'tl-hours' });
    this.gridEl = h('div', { class: 'tl-grid' });
    this.barsEl = h('div', { class: 'tl-bars' });
    this.shadeEl = h('div', { class: 'tl-shade' });
    this.emptyEl = h('div', { class: 'tl-empty', hidden: true }, 'Пока пусто. Нажмите «+» или на свободное место, чтобы добавить задачу');
    this.laneEl = h('div', { class: 'tl-lane' }, this.gridEl, this.shadeEl, this.barsEl, this.emptyEl);
    this.railEl = h('div', { class: 'tl-rail' });
    this.nowTimeEl = h('span', { class: 'tl-now-time' });
    this.nowEl = h('div', { class: 'tl-now' }, this.nowTimeEl);
    this.canvas = h('div', { class: 'tl-canvas' }, this.daysEl, this.hoursEl, this.laneEl, this.railEl, this.nowEl);
    this.scroll = h('div', { class: 'tl-scroll' }, this.canvas);
    this.tip = h('div', { class: 'tl-tip', hidden: true });
    this.zoomOut = h('button', { class: 'tool', type: 'button', title: 'Уменьшить масштаб', 'aria-label': 'Уменьшить масштаб', onclick: () => this.setZoom(this.zoom - 1) }, icon('minus', 16));
    this.zoomIn = h('button', { class: 'tool', type: 'button', title: 'Увеличить масштаб', 'aria-label': 'Увеличить масштаб', onclick: () => this.setZoom(this.zoom + 1) }, icon('plus', 16));
    this.tools = h(
      'div',
      { class: 'tl-tools' },
      h('button', { class: 'tool tool-text', type: 'button', onclick: () => this.scrollToNow(true) }, 'Сегодня'),
      this.zoomOut,
      this.zoomIn,
    );
    this.zoomOut.disabled = this.zoom === 0;
    this.zoomIn.disabled = this.zoom === ZOOMS.length - 1;
    this.el = h('section', { class: 'tl', 'aria-label': 'График работ' }, this.scroll, this.tools);
    root.append(this.el);
    document.body.append(this.tip);
    this.bind();
  }

  get hourPx() {
    return ZOOMS[this.zoom];
  }

  // ---------- Обновление ----------

  update(view) {
    this.view = view;
    const { doc, plan, now } = view;
    this.ensureRange(plan, now);
    const extents = collectExtents(plan, doc);
    const calendar = calendarOf(doc);
    const today = toKey(now);
    const signature = JSON.stringify([
      this.hourPx,
      this.range,
      today,
      doc.settings.week,
      doc.settings.holidays,
      doc.days,
      [...extents.entries()].sort(),
    ]);
    if (signature !== this.signature) {
      const width = this.scroll.clientWidth;
      const pin = this.axis ? this.axis.timeAt(this.scroll.scrollLeft + width / 2) : null;
      this.axis = buildAxis({ calendar, ...this.range, hourPx: this.hourPx, extents });
      this.renderGrid(today);
      if (pin != null) this.scroll.scrollLeft = this.axis.x(pin) - width / 2;
      this.signature = signature;
      this.skipAnimation = this.lastHourPx !== this.hourPx;
      this.lastHourPx = this.hourPx;
    }
    this.renderBars(view);
    this.renderRail(view);
    this.renderNow(now);
    this.emptyEl.hidden = plan.items.length > 0 || plan.pinned.length > 0;
    if (!this.emptyEl.hidden) this.emptyEl.style.left = `${this.axis.x(now) + 16}px`;
    if (!this.initialized) {
      this.initialized = true;
      this.scrollToNow(false);
    }
  }

  ensureRange(plan, now) {
    const today = toKey(now);
    const end = plan.planEnd ?? now;
    const lastPin = plan.pinned.reduce((max, item) => Math.max(max, item.end), end);
    const from = shiftKey(today, -14);
    const to = shiftKey(toKey(Math.max(end, lastPin, now)), 45);
    if (!this.range) this.range = { from, to };
    else {
      if (from < this.range.from) this.range.from = from;
      if (to > this.range.to) this.range.to = to;
    }
  }

  extendPast() {
    this.range.from = shiftKey(this.range.from, -30);
    this.update(store.view());
  }

  setZoom(index) {
    const next = clamp(index, 0, ZOOMS.length - 1);
    if (next === this.zoom) return;
    this.zoom = next;
    writeStorage(ZOOM_KEY, String(this.hourPx));
    this.zoomOut.disabled = next === 0;
    this.zoomIn.disabled = next === ZOOMS.length - 1;
    this.update(store.view());
  }

  scrollToMoment(t, { smooth = true, align = 0.18 } = {}) {
    const left = this.axis.x(t) - this.scroll.clientWidth * align;
    const behavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
    this.scroll.scrollTo({ left: Math.max(0, left), behavior });
  }

  scrollToNow(smooth) {
    this.scrollToMoment(store.now(), { smooth });
  }

  // Показывает задачу целиком, если она помещается, иначе — её начало.
  revealTask(id, smooth = true) {
    const item = store.view().plan.byId.get(id);
    if (!item) return;
    const a = this.axis.x(item.start);
    const b = this.axis.x(item.end);
    const width = this.scroll.clientWidth;
    const left = this.scroll.scrollLeft;
    if (a >= left + 12 && b <= left + width - 12) return;
    const target = b - a < width - 60 ? a - (width - (b - a)) / 2 : a - 24;
    this.scroll.scrollTo({ left: Math.max(0, target), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  }

  bottom() {
    return this.el.getBoundingClientRect().bottom;
  }

  // Индекс в очереди по координате на экране — для перетаскивания из списка.
  indexAtClient(clientX, skipId) {
    const { plan } = store.base();
    const x = this.pointerX(clientX);
    const others = plan.items.filter((item) => item.id !== skipId);
    for (let i = 0; i < others.length; i += 1) {
      if (x < (this.axis.x(others[i].start) + this.axis.x(others[i].end)) / 2) return i;
    }
    return others.length;
  }

  containsPoint(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  // ---------- Сетка ----------

  renderGrid(today) {
    const { blocks, hourPx, total } = this.axis;
    const days = [];
    const hours = [];
    const grid = [];
    for (const block of blocks) {
      if (block.type === 'off') {
        const key = block.keys[0];
        days.push(h('div', {
          class: 'd-off-head',
          style: { left: `${block.x}px`, width: `${block.w}px` },
          data: { day: key },
          role: 'button',
          tabIndex: 0,
          'aria-label': `Нерабочие дни: ${offLabel(block)}. Настроить`,
          title: offLabel(block),
        }));
        hours.push(h('div', { class: 'd-off-hours', style: { left: `${block.x}px`, width: `${block.w}px` } }));
        grid.push(h('div', {
          class: `d-off${block.keys.includes(today) ? ' is-today' : ''}`,
          style: { left: `${block.x}px`, width: `${block.w}px` },
          data: { day: key },
        }, h('span', { class: 'd-off-label' }, offLabel(block))));
        continue;
      }
      days.push(this.dayHead(block, today));
      hours.push(this.hourLabels(block));
      grid.push(this.dayGrid(block, today));
    }
    this.daysEl.replaceChildren(...days);
    this.hoursEl.replaceChildren(...hours);
    this.gridEl.replaceChildren(...grid);
    this.canvas.style.width = `${total}px`;
    this.el.style.setProperty('--hour', `${hourPx}px`);
  }

  dayHead(block, today) {
    const date = new Date(atKey(block.key));
    const wide = block.w >= 130;
    const months = wide
      ? ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
      : ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const minutes = workMinutes(block.plan);
    const isToday = block.key === today;
    return h(
      'div',
      {
        class: `d-head${isToday ? ' is-today' : ''}${block.plan.source === 'custom' ? ' is-custom' : ''}`,
        style: { left: `${block.x}px`, width: `${block.w}px` },
        data: { day: block.key },
        role: 'button',
        tabIndex: 0,
        'aria-label': `Настроить день: ${date.getDate()} ${months[date.getMonth()]}`,
      },
      h(
        'span',
        { class: 'd-label' },
        h('b', null, DAYS[date.getDay()]),
        ` ${date.getDate()} ${months[date.getMonth()]}`,
        block.plan.source === 'custom' ? h('i', { class: 'd-dot', title: 'Этот день настроен отдельно' }) : null,
        block.w >= 190 && minutes ? h('span', { class: 'd-sum' }, fmtDur(minutes)) : null,
      ),
    );
  }

  hourLabels(block) {
    const { hourPx } = this.axis;
    const every = hourPx < 20 ? 3 : 1;
    const labels = [];
    for (let m = block.vs; m < block.ve; m += 60) {
      const hour = m / 60;
      if ((hour - block.vs / 60) % every) continue;
      const pad = String(hour).padStart(2, '0');
      const text = hourPx >= 64 ? `${pad}–${String(hour + 1).padStart(2, '0')}` : hourPx >= 32 ? pad : String(hour);
      labels.push(h('span', { style: { left: `${((m - block.vs) / 60) * hourPx}px`, width: `${hourPx * every}px` } }, text));
    }
    return h('div', { class: 'd-hours', style: { left: `${block.x}px`, width: `${block.w}px` } }, labels);
  }

  dayGrid(block, today) {
    const { hourPx } = this.axis;
    const bands = [];
    const breaks = block.plan.on ? block.plan.breaks ?? [] : [];
    const addBand = (a, b) => {
      const pause = breaks.find((item) => parseHM(item.start) < b && parseHM(item.end) > a);
      bands.push(h('div', {
        class: `d-band${pause ? ' is-break' : ''}`,
        style: { left: `${((a - block.vs) / 60) * hourPx}px`, width: `${((b - a) / 60) * hourPx}px` },
      }, pause?.label ? h('span', null, pause.label) : null));
    };
    let cursor = block.vs;
    for (const [s, e] of block.spans) {
      if (s > cursor) addBand(cursor, s);
      cursor = e;
    }
    if (cursor < block.ve) addBand(cursor, block.ve);
    return h('div', {
      class: `d-grid${block.key === today ? ' is-today' : ''}${hourPx < 20 ? ' is-dense' : ''}`,
      style: { left: `${block.x}px`, width: `${block.w}px` },
    }, bands);
  }

  // ---------- Задачи ----------

  renderBars(view) {
    const { plan, doc, now, ghostId, dragId } = view;
    const axis = this.axis;
    const nodes = [];
    const lefts = new Map();

    const addSegments = (task, segments, options = {}) => {
      segments.forEach((segment, index) => {
        const left = axis.x(segment.s);
        const right = segment.e - segment.s > 0 ? axis.x(segment.e) : left;
        const width = Math.max(right - left, 2);
        const key = `${task.id}:${index}`;
        lefts.set(key, left);
        nodes.push(this.segment(task, segment, {
          left,
          width,
          key,
          isFirst: index === 0,
          isLast: index === segments.length - 1,
          ...options,
        }));
        const next = segments[index + 1];
        if (next && next.kind !== 'past' && segment.kind !== 'past') {
          const nextLeft = axis.x(next.s);
          if (nextLeft - right > 1) {
            nodes.push(h('div', { class: `seg-thread c-${task.color}`, style: { left: `${right}px`, width: `${nextLeft - right}px` } }));
          }
        }
      });
    };

    for (const task of Object.values(doc.tasks)) {
      if (task.deleted || task.status !== 'done' || !task.history?.length) continue;
      addSegments(task, task.history.map(([s, e]) => ({ s, e, kind: 'done' })), { done: true });
    }

    for (const item of plan.items) {
      const past = (item.task.history ?? []).map(([s, e]) => ({ s, e, kind: 'past' }));
      const flags = {
        item,
        late: item.late > 0,
        current: item.isCurrent,
        ghost: item.id === ghostId,
        dragging: item.id === dragId,
      };
      addSegments(item.task, [...past, ...item.segments], flags);
      for (const gap of item.gap) {
        const left = axis.x(gap.s);
        const width = axis.x(gap.e) - left;
        if (width < 1) continue;
        nodes.push(h('div', {
          class: `gap c-${item.task.color}`,
          style: { left: `${left}px`, width: `${width}px` },
          data: { id: item.id },
          title: `Запас перед «${item.task.title}»: ${fmtDur(item.task.lag)}`,
        }, width > 44 && gap === item.gap[0] ? h('span', null, `+${fmtDur(item.task.lag)}`) : null));
      }
    }

    for (const item of plan.pinned) {
      addSegments(item.task, item.segments, { item, pinned: true, ghost: item.id === ghostId, dragging: item.id === dragId });
    }

    for (const task of Object.values(doc.tasks)) {
      if (task.deleted || !task.deadline || task.status === 'done' || task.status === 'backlog') continue;
      const item = plan.byId.get(task.id);
      const late = item?.late > 0;
      nodes.push(h('div', {
        class: `flag c-${task.color}${late ? ' is-late' : ''}`,
        style: { left: `${axis.x(task.deadline)}px` },
        title: `Дедлайн «${task.title}»: ${fmtMoment(task.deadline, now)}`,
      }, icon('flag', 14)));
    }

    this.barsEl.replaceChildren(...nodes);
    // Элемент под пальцем должен оставаться в документе, иначе браузер перестанет присылать его касания.
    const touched = this.press?.source === 'touch' ? this.press.segEl : null;
    if (touched) {
      touched.classList.add('is-touch-anchor');
      this.barsEl.append(touched);
    }
    this.animateShift(lefts, dragId);
    this.prevLefts = lefts;
  }

  segment(task, segment, options) {
    const { left, width, key, isFirst, isLast, item, late, current, ghost, dragging, pinned, done } = options;
    const { now } = this.view;
    const movable = Boolean(item) && segment.kind !== 'past' && !done;
    const classes = [
      'seg',
      `c-${task.color}`,
      `k-${segment.kind}`,
      isFirst && 'is-first',
      isLast && 'is-last',
      late && 'is-late',
      current && 'is-current',
      ghost && 'is-ghost',
      dragging && 'is-dragging',
      pinned && 'is-pinned',
      width < 58 && 'is-narrow',
      width < 12 && 'is-sliver',
    ].filter(Boolean).join(' ');

    const content = [];
    if (width >= 12) {
      const title = h('span', { class: 'seg-title' },
        done ? icon('check', 13) : null,
        pinned ? icon('pin', 13) : null,
        task.title || 'Без названия');
      content.push(title);
      if (task.note && width >= 96) content.push(h('span', { class: 'seg-note' }, task.note));
    }
    const showTail = isLast && !done && item && width >= 40;
    const tail = showTail
      ? h('span', { class: 'seg-tail' }, late ? icon('warn', 12) : null, width >= 76 ? fmtShort(item.end, now) : fmtTime(item.end))
      : null;

    const title = item
      ? `${task.title}\n${fmtDur(task.dur)} · ${fmtMoment(item.start, now)} → ${fmtMoment(item.end, now)}`
      : `${task.title}\nГотово`;

    return h(
      'div',
      {
        class: classes,
        style: { left: `${left}px`, width: `${width}px` },
        role: 'button',
        tabIndex: isFirst ? 0 : -1,
        title,
        data: { id: task.id, key, movable: movable ? '1' : '' },
      },
      h('div', { class: 'seg-in' }, content),
      tail,
      movable && isLast && !pinned ? h('i', { class: 'seg-grip', title: 'Потяните, чтобы изменить длительность' }) : null,
    );
  }

  animateShift(lefts, dragId) {
    if (this.skipAnimation || prefersReducedMotion()) {
      this.skipAnimation = false;
      return;
    }
    const duration = dragId ? 130 : 280;
    for (const el of this.barsEl.querySelectorAll('.seg')) {
      const { key, id } = el.dataset;
      if (id === dragId || el.classList.contains('is-touch-anchor')) continue;
      const before = this.prevLefts.get(key);
      const after = lefts.get(key);
      if (before == null || Math.abs(before - after) < 1) continue;
      el.animate(
        [{ transform: `translateX(${before - after}px)` }, { transform: 'translateX(0)' }],
        { duration, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  }

  // ---------- Вехи: окончания задач и места для вставки ----------

  renderRail(view) {
    const { plan, now } = view;
    const axis = this.axis;
    const marks = [];
    const first = plan.items[0];
    if (!first) {
      marks.push({ x: axis.x(now), text: '', placement: { kind: 'end' }, label: 'Добавить задачу' });
    } else if (first.isCurrent) {
      marks.push({ x: axis.x(now), text: '', placement: { kind: 'now' }, label: 'Вставить сейчас, прервав текущую' });
    } else {
      marks.push({ x: axis.x(first.start), text: '', placement: { kind: 'now' }, label: 'Вставить перед первой' });
    }
    for (const item of plan.items) {
      marks.push({
        x: axis.x(item.end),
        text: fmtShort(item.end, now),
        placement: { kind: 'after', id: item.id },
        label: `Вставить после «${item.task.title}», она заканчивается ${fmtMoment(item.end, now)}`,
        late: item.late > 0,
      });
    }
    marks.sort((a, b) => a.x - b.x);
    const nodes = [];
    let previous = -Infinity;
    for (const mark of marks) {
      const gap = mark.x - previous;
      if (gap < 28) continue;
      const showText = mark.text && gap >= 104;
      nodes.push(h(
        'button',
        {
          class: `mark${mark.late ? ' is-late' : ''}`,
          type: 'button',
          style: { left: `${mark.x}px` },
          'aria-label': mark.label,
          title: mark.label,
          data: { placement: JSON.stringify(mark.placement) },
        },
        showText ? h('span', { class: 'mark-text' }, mark.text) : null,
        h('span', { class: 'mark-plus' }, icon('plus', 14)),
      ));
      previous = mark.x;
    }
    this.railEl.replaceChildren(...nodes);
  }

  renderNow(now) {
    const x = this.axis.x(now);
    this.nowEl.style.left = `${x}px`;
    this.nowTimeEl.textContent = fmtTime(now);
    this.shadeEl.style.width = `${x}px`;
  }

  // ---------- Жесты ----------

  bind() {
    const { scroll } = this;

    scroll.addEventListener('click', (event) => this.onClick(event));
    scroll.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target.closest('[role="button"]');
      if (!target) return;
      event.preventDefault();
      target.click();
    });

    scroll.addEventListener('wheel', (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        this.setZoom(this.zoom + (event.deltaY < 0 ? 1 : -1));
        return;
      }
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        scroll.scrollLeft += event.deltaY;
      }
    }, { passive: false });

    scroll.addEventListener('scroll', () => {
      if (scroll.scrollLeft < 240 && this.axis && !this.drag) this.extendPast();
    }, { passive: true });

    // Мышь
    scroll.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      this.suppressClick = false;
      this.beginPress(event.target, event.clientX, event.clientY, 'mouse');
    });
    window.addEventListener('pointermove', (event) => {
      if (this.press?.source === 'mouse') this.movePress(event.clientX, event.clientY);
    });
    window.addEventListener('pointerup', () => {
      if (this.press?.source === 'mouse') this.endPress();
    });

    // Палец: перетаскивание начинается после долгого нажатия, обычный свайп листает график.
    scroll.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) {
        this.cancelPress();
        return;
      }
      const touch = event.touches[0];
      this.suppressClick = false;
      this.beginPress(event.target, touch.clientX, touch.clientY, 'touch');
    }, { passive: true });
    scroll.addEventListener('touchmove', (event) => {
      if (this.press?.source !== 'touch') return;
      const touch = event.touches[0];
      this.movePress(touch.clientX, touch.clientY);
      if (this.drag) event.preventDefault();
    }, { passive: false });
    scroll.addEventListener('touchend', (event) => {
      if (this.press?.source !== 'touch') return;
      if (this.drag) event.preventDefault();
      this.endPress();
    });
    scroll.addEventListener('touchcancel', () => this.cancelPress());

    // Щипок двумя пальцами меняет масштаб ступенями.
    let pinchBase = 1;
    this.el.addEventListener('gesturestart', (event) => {
      event.preventDefault();
      pinchBase = 1;
    });
    this.el.addEventListener('gesturechange', (event) => {
      event.preventDefault();
      if (event.scale / pinchBase > 1.3) {
        pinchBase = event.scale;
        this.setZoom(this.zoom + 1);
      } else if (event.scale / pinchBase < 0.77) {
        pinchBase = event.scale;
        this.setZoom(this.zoom - 1);
      }
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.drag) this.cancelDrag();
    });
  }

  onClick(event) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const mark = event.target.closest('.mark');
    if (mark) {
      this.handlers.onMark(JSON.parse(mark.dataset.placement));
      return;
    }
    const day = event.target.closest('[data-day]');
    if (day) {
      this.handlers.onDay(day.dataset.day);
      return;
    }
    const seg = event.target.closest('.seg, .gap');
    if (seg) {
      this.handlers.onTask(seg.dataset.id);
      return;
    }
    if (event.target.closest('.tl-lane')) {
      const t = this.axis.timeAt(this.pointerX(event.clientX));
      this.handlers.onLane(t);
    }
  }

  pointerX(clientX) {
    return clientX - this.scroll.getBoundingClientRect().left + this.scroll.scrollLeft;
  }

  beginPress(target, cx, cy, source) {
    this.cancelPress();
    if (store.preview && !this.handlers.canDrag?.()) return;
    const seg = target.closest('.seg');
    const movable = seg?.dataset.movable === '1';
    if (seg && movable) {
      const zone = target.closest('.seg-grip') ? 'resize' : 'body';
      this.press = { source, id: seg.dataset.id, zone, cx, cy, moved: false, segEl: seg };
      if (source === 'touch') {
        this.press.timer = setTimeout(() => {
          if (this.press && !this.drag) this.startDrag(this.press);
        }, LONG_PRESS);
      }
      return;
    }
    if (source === 'mouse' && target.closest('.tl-lane') && !seg) {
      this.press = { source, pan: true, cx, cy, left: this.scroll.scrollLeft, moved: false };
    }
  }

  movePress(cx, cy) {
    const { press } = this;
    if (!press) return;
    const distance = Math.hypot(cx - press.cx, cy - press.cy);
    if (this.drag) {
      this.drag.cx = cx;
      this.drag.cy = cy;
      this.updateDrag();
      return;
    }
    if (press.pan) {
      if (distance > 4) {
        press.moved = true;
        this.scroll.scrollLeft = press.left - (cx - press.cx);
      }
      return;
    }
    if (press.source === 'touch') {
      if (distance > 10) this.cancelPress(); // это свайп, листаем график
      return;
    }
    if (distance > 5) this.startDrag(press);
  }

  endPress() {
    const { press } = this;
    if (!press) return;
    clearTimeout(press.timer);
    this.press = null;
    if (this.drag) {
      this.finishDrag();
      this.suppressClick = true;
    } else if (press.pan && press.moved) {
      this.suppressClick = true;
    }
  }

  cancelPress() {
    if (!this.press) return;
    clearTimeout(this.press.timer);
    this.press = null;
  }

  startDrag(press) {
    const base = store.base();
    const item = base.plan.byId.get(press.id);
    if (!item) return;
    const mode = item.pinned ? 'pin' : press.zone === 'resize' ? 'resize' : 'shift';
    this.drag = {
      id: press.id,
      mode,
      item,
      base,
      cx: press.cx,
      cy: press.cy,
      grabDx: this.pointerX(press.cx) - this.axis.x(item.start),
      apply: null,
      changed: false,
    };
    document.body.classList.add('is-grabbing');
    this.startAutoScroll();
    this.updateDrag();
  }

  updateDrag() {
    const { drag } = this;
    const { id, item, base, grabDx } = drag;
    const { doc, plan, now } = base;
    const x = this.pointerX(drag.cx);
    const lane = this.laneEl.getBoundingClientRect();
    const lifted = drag.cy < lane.top - LIFT_DISTANCE || drag.cy > lane.bottom + LIFT_DISTANCE;
    const draft = clone(doc);
    let tip = '';

    if (drag.mode === 'pin') {
      const at = this.axis.timeAt(x - grabDx);
      draft.tasks[id].pinAt = at;
      drag.apply = (d) => {
        d.tasks[id].pinAt = at;
      };
      tip = `Начало: ${fmtMoment(at, now)}`;
    } else if (drag.mode === 'resize') {
      const t = this.axis.timeAt(x);
      const minutes = Math.max(STEP, roundTo(plan.clock.between(item.start, t)));
      setRemaining(draft, id, minutes);
      drag.apply = (d) => setRemaining(d, id, minutes);
      tip = `Осталось ${fmtDur(minutes)}`;
    } else if (lifted) {
      const index = this.indexAtClient(drag.cx, id);
      placeTask(draft, id, { kind: 'index', index }, now);
      drag.apply = (d, t) => placeTask(d, id, { kind: 'index', index }, t);
      drag.reordered = true;
      const others = plan.items.filter((other) => other.id !== id);
      tip = index === 0 ? 'Поставить первой' : `Поставить после «${others[index - 1].task.title}»`;
    } else {
      const at = this.axis.timeAt(x - grabDx);
      const index = item.index;
      const prevEnd = index === 0 ? doc.plan.anchor ?? now : plan.items[index - 1].end;
      const lag = at > prevEnd ? roundTo(plan.clock.between(prevEnd, at)) : 0;
      draft.tasks[id].lag = lag;
      drag.apply = (d) => {
        d.tasks[id].lag = lag;
      };
      drag.reordered = false;
      const start = plan.clock.next(plan.clock.allocate(prevEnd, lag).end);
      tip = `Старт: ${fmtMoment(start, now)}${lag ? ` · запас ${fmtDur(lag)}` : ''}\nПотяните вверх или вниз, чтобы поменять порядок`;
    }

    drag.draft = draft;
    store.setPreview(draft, { dragId: id });
    this.showTip(tip, drag.cx, lane.top);
  }

  showTip(text, cx, top) {
    this.tip.hidden = false;
    this.tip.textContent = text;
    const width = this.tip.offsetWidth;
    this.tip.style.left = `${clamp(cx - width / 2, 8, window.innerWidth - width - 8)}px`;
    this.tip.style.top = `${Math.max(8, top - this.tip.offsetHeight - 8)}px`;
  }

  startAutoScroll() {
    const step = () => {
      if (!this.drag) return;
      const rect = this.scroll.getBoundingClientRect();
      const { cx } = this.drag;
      const edge = 56;
      let delta = 0;
      if (cx < rect.left + edge) delta = -((rect.left + edge - cx) / edge) * 14;
      else if (cx > rect.right - edge) delta = ((cx - (rect.right - edge)) / edge) * 14;
      if (delta) {
        this.scroll.scrollLeft += delta;
        this.updateDrag();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  finishDrag() {
    const { drag } = this;
    this.drag = null;
    this.tip.hidden = true;
    document.body.classList.remove('is-grabbing');
    if (!drag.apply) {
      store.clearPreview();
      return;
    }
    const before = JSON.stringify([store.doc.plan.order, store.doc.tasks[drag.id]]);
    store.commit(drag.apply);
    const after = JSON.stringify([store.doc.plan.order, store.doc.tasks[drag.id]]);
    if (before === after) return;
    const { plan, now } = store.base();
    const item = plan.byId.get(drag.id);
    if (item) {
      toast(`«${item.task.title}» закончится ${fmtMoment(item.end, now)}`, {
        action: { label: 'Отменить', run: () => store.undo() },
      });
    }
  }

  cancelDrag() {
    this.drag = null;
    this.press = null;
    this.tip.hidden = true;
    document.body.classList.remove('is-grabbing');
    store.clearPreview();
  }
}
