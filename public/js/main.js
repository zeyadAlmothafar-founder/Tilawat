// Studio entry point: i18n, theme, hash routing between the four pages.
import { initI18n, mountLanguageSelect, onLanguageChange, t } from './i18n.js';
import { initTheme } from './theme.js';
import * as create from './create.js';
import * as videos from './videos.js';
import * as library from './library.js';
import * as about from './about.js';

const ROUTES = { create, videos, library, about };
const DEFAULT_ROUTE = 'create';
let current = null;

function routeFromHash() {
  const name = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  if (ROUTES[name]) return name;
  return current || DEFAULT_ROUTE;
}

function updateTitle() {
  const label = t(`nav.${current}`);
  document.title = `${label} · ${t('app.name')}`;
}

function route() {
  const next = routeFromHash();
  if (next === current) return;
  const first = current === null;
  if (current) ROUTES[current].hide?.();
  current = next;

  for (const section of document.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== next;
  for (const link of document.querySelectorAll('[data-route]')) {
    if (link.dataset.route === next) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  ROUTES[next].show?.();
  updateTitle();
  if (!first) {
    window.scrollTo({ top: 0 });
    document.querySelector(`[data-page="${next}"] h1`)?.focus({ preventScroll: true });
  }
}

async function boot() {
  await initI18n();
  initTheme(document.getElementById('theme-toggle'));
  mountLanguageSelect(document.getElementById('lang-select'));
  for (const [name, mod] of Object.entries(ROUTES)) mod.init?.(document.querySelector(`[data-page="${name}"]`));

  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('main')?.focus();
  });
  window.addEventListener('hashchange', route);
  onLanguageChange(updateTitle);
  route();
  document.body.classList.remove('is-booting');
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.remove('is-booting');
});
