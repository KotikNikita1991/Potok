// Всплывающие подсказки и контекстные меню.

import { h, icon } from './dom.js';

let toastEl = null;
let toastTimer = null;

export function toast(text, { action = null, timeout = 6000 } = {}) {
  clearTimeout(toastTimer);
  toastEl?.remove();
  const close = () => {
    clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
  };
  toastEl = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', { class: 'toast-text' }, text),
    action &&
      h('button', {
        class: 'toast-action',
        type: 'button',
        onclick: () => {
          close();
          action.run();
        },
      }, action.label),
  );
  document.body.append(toastEl);
  toastTimer = setTimeout(close, timeout);
}

let menuEl = null;
let menuCleanup = null;

export function closeMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menuEl?.remove();
  menuEl = null;
}

export function menuItem({ iconName, label, hint, danger, run }) {
  return h(
    'button',
    {
      class: `menu-item${danger ? ' is-danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      onclick: () => {
        closeMenu();
        run();
      },
    },
    iconName ? icon(iconName) : null,
    h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, label), hint ? h('span', { class: 'menu-hint' }, hint) : null),
  );
}

export function openMenu(anchor, children, { label = 'Меню' } = {}) {
  closeMenu();
  menuEl = h('div', { class: 'menu', role: 'menu', 'aria-label': label }, children);
  document.body.append(menuEl);

  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h2 } = menuEl;
  const margin = 8;
  const left = Math.min(Math.max(margin, rect.right - w), window.innerWidth - w - margin);
  const below = rect.bottom + 6;
  const top = below + h2 > window.innerHeight - margin ? Math.max(margin, rect.top - h2 - 6) : below;
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;

  const onPointer = (event) => {
    if (!menuEl?.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
  });
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onPointer);
    document.removeEventListener('keydown', onKey);
  };
  menuEl.querySelector('button, input')?.focus({ preventScroll: true });
}
