// Light/dark theme: follows prefers-color-scheme until the user picks one with the toggle.
import { t, onLanguageChange, storageSet } from './i18n.js';
import { icon } from './icons.js';

const STORAGE_KEY = 'qvs.theme';
const THEME_COLORS = { light: '#0c4a3e', dark: '#071c19' };

export function initTheme(button) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  const effective = () => root.dataset.theme || (media.matches ? 'dark' : 'light');

  function render() {
    const dark = effective() === 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLORS[effective()];
    if (!button) return;
    const label = t(dark ? 'header.themeToLight' : 'header.themeToDark');
    button.replaceChildren(icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  button?.addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    storageSet(STORAGE_KEY, next);
    render();
  });
  media.addEventListener('change', render);
  onLanguageChange(render);
  render();
}
