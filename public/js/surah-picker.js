// Searchable surah combobox: a button showing the current surah that opens a popover
// with a search field and a listbox (keyboard: ↑ ↓ Home End Enter Esc).
import { t, getLang, fmtNumber } from './i18n.js';
import { h, nextId } from './ui.js';
import { icon } from './icons.js';

// Fold case, diacritics/harakat, tatweel and common Arabic-script letter variants.
export function normalizeSearch(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ـ/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[ةۃ]/g, 'ه')
    .toLowerCase()
    .replace(/[‘’'`ʿʾ-]/g, '')
    .trim();
}

// The Arabic UI already shows the Arabic name, so it skips the Latin transliteration and meaning.
const showLatinNames = () => getLang() !== 'ar';

export const surahMeaning = (s) => s.meanings?.[getLang()] || s.meaningEn || null;

function haystack(s) {
  const parts = [s.number, s.nameEn, s.nameAr, s.meaningEn, ...Object.values(s.meanings || {})];
  const text = normalizeSearch(parts.filter(Boolean).join(' '));
  return `${text} ${text.replace(/\s+/g, '')}`;
}

/**
 * @param {object} o
 * @param {Array}  o.surahs     list from /api/surahs
 * @param {number} o.value      selected surah number
 * @param {(n:number)=>void} o.onChange
 * @param {string} o.labelId    id of the visible label element
 */
export function createSurahPicker({ surahs, value, onChange, labelId }) {
  const listId = nextId('surah-list');
  const index = new Map(surahs.map((s) => [s.number, haystack(s)]));
  let selected = value;
  let filtered = surahs;
  let active = 0;

  const buttonContent = h('span', { class: 'sp-current' });
  const button = h(
    'button',
    { type: 'button', class: 'picker-button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-labelledby': `${labelId} ${listId}-btn`, id: `${listId}-btn` },
    buttonContent,
    icon('chevronDown', 'picker-chevron'),
  );
  const input = h('input', {
    type: 'search',
    class: 'picker-input',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'true',
    'aria-controls': listId,
    placeholder: t('create.picker.search'),
    'aria-label': t('create.picker.search'),
  });
  const list = h('ul', { class: 'picker-list', role: 'listbox', id: listId, 'aria-labelledby': labelId });
  const empty = h('p', { class: 'picker-empty', hidden: true });
  const pop = h('div', { class: 'picker-pop', hidden: true }, h('div', { class: 'picker-search' }, icon('search'), input), list, empty);
  const root = h('div', { class: 'surah-picker' }, button, pop);

  function renderButton() {
    const s = surahs.find((x) => x.number === selected);
    if (!s) {
      buttonContent.replaceChildren(h('span', { class: 'sp-placeholder', text: t('create.picker.choose') }));
      return;
    }
    const meaning = surahMeaning(s);
    buttonContent.replaceChildren(
      h('span', { class: 'sp-num', text: fmtNumber(s.number) }),
      h(
        'span',
        { class: 'sp-names' },
        h('span', { class: 'sp-ar ar-name', lang: 'ar', dir: 'rtl', text: s.nameAr }),
        showLatinNames() && h('span', { class: 'sp-sub', text: [s.nameEn, meaning].filter(Boolean).join(' · ') }),
      ),
    );
  }

  function optionFor(s, i) {
    const meaning = surahMeaning(s);
    return h(
      'li',
      {
        role: 'option',
        id: `${listId}-${s.number}`,
        class: `picker-option ${i === active ? 'is-active' : ''}`,
        'aria-selected': String(s.number === selected),
        dataset: { number: s.number },
      },
      h('span', { class: 'sp-num', text: fmtNumber(s.number) }),
      showLatinNames() && h('span', { class: 'sp-names' }, h('span', { class: 'sp-en', text: s.nameEn }), meaning && h('span', { class: 'sp-sub', text: meaning })),
      h('span', { class: 'sp-ar ar-name', lang: 'ar', dir: 'rtl', text: s.nameAr }),
    );
  }

  function renderList() {
    list.replaceChildren(...filtered.map(optionFor));
    empty.hidden = filtered.length > 0;
    empty.textContent = t('create.picker.noResults', { query: input.value });
    syncActive();
  }

  function syncActive() {
    const items = list.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('is-active', i === active);
    const el = items[active];
    if (el) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function filter() {
    const q = normalizeSearch(input.value);
    if (!q) filtered = surahs;
    else if (/^\d+$/.test(q)) filtered = surahs.filter((s) => String(s.number).startsWith(q));
    else {
      const compact = q.replace(/\s+/g, '');
      filtered = surahs.filter((s) => index.get(s.number).includes(q) || index.get(s.number).includes(compact));
    }
    active = 0;
    renderList();
  }

  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    input.value = '';
    filtered = surahs;
    active = Math.max(0, surahs.findIndex((s) => s.number === selected));
    renderList();
    input.focus();
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close({ focusButton = false } = {}) {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focusButton) button.focus();
  }

  function choose(number) {
    const changed = number !== selected;
    selected = number;
    renderButton();
    close({ focusButton: true });
    if (changed) onChange(number);
  }

  function onOutside(e) {
    if (!root.contains(e.target)) close();
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    const last = filtered.length - 1;
    if (e.key === 'ArrowDown') active = Math.min(last, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'PageDown') active = Math.min(last, active + 8);
    else if (e.key === 'PageUp') active = Math.max(0, active - 8);
    else if (e.key === 'Home' && e.ctrlKey) active = 0;
    else if (e.key === 'End' && e.ctrlKey) active = last;
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) choose(filtered[active].number); return; }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ focusButton: true }); return; }
    else if (e.key === 'Tab') { close(); return; }
    else return;
    e.preventDefault();
    syncActive();
  });
  list.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"]');
    if (option) choose(Number(option.dataset.number));
  });
  list.addEventListener('pointermove', (e) => {
    const option = e.target.closest('[role="option"]');
    if (!option) return;
    const i = [...list.children].indexOf(option);
    if (i !== active && i >= 0) { active = i; for (let k = 0; k < list.children.length; k++) list.children[k].classList.toggle('is-active', k === active); }
  });

  renderButton();
  return {
    el: root,
    button,
    setValue(n) { selected = n; renderButton(); },
  };
}
