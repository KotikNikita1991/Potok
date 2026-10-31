// Панель редактирования. Открывается под графиком, чтобы изменения были видны на нём сразу.

import { h } from './dom.js';

let active = null;

export function isSheetOpen() {
  return Boolean(active);
}

export function activeSheet() {
  return active;
}

export function closeSheet() {
  if (!active) return;
  const { el, onClose, onKey } = active;
  active = null;
  document.removeEventListener('keydown', onKey);
  document.body.classList.remove('has-sheet');
  el.remove();
  onClose?.();
}

export function positionSheet(ctx) {
  if (!active) return;
  const available = ctx.timeline.bottom();
  const roomy = window.innerHeight - available >= 280;
  active.el.style.setProperty('--sheet-top', `${roomy ? available : 0}px`);
}

export function openSheet(ctx, { title, content, cancelLabel = 'Отмена', primaryLabel, onPrimary, onClose, name = '', extra = null, headLeft = null, titleEl = null }) {
  closeSheet();
  const head = h(
    'div',
    { class: 'sheet-head' },
    h('div', { class: 'sheet-head-left' },
      headLeft,
      cancelLabel ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeSheet }, cancelLabel) : null),
    titleEl ?? h('div', { class: 'sheet-title' }, title),
    h('div', { class: 'sheet-head-right' },
      extra,
      primaryLabel ? h('button', { class: 'btn btn-primary', type: 'button', onclick: onPrimary }, primaryLabel) : null),
  );
  const body = h('div', { class: 'sheet-body' }, content);
  const el = h('section', { class: `sheet${name ? ` sheet-${name}` : ''}`, role: 'dialog', 'aria-label': title }, head, body);
  const onKey = (event) => {
    if (event.key === 'Escape' && !document.querySelector('.menu')) closeSheet();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && onPrimary) onPrimary();
  };
  active = { el, name, onClose, onKey, data: {} };
  document.addEventListener('keydown', onKey);
  document.body.classList.add('has-sheet');
  document.body.append(el);
  positionSheet(ctx);
  return active;
}

// Высота экранной клавиатуры: чтобы нижние поля можно было прокрутить над ней.
export function watchKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const height = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(height)}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
}
