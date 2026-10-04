// Which build is running: the self-hosted app (server renders videos) or the static web
// version (videos are rendered in the browser; web/build.js sets <html data-mode="web">).
export const WEB_MODE = document.documentElement.dataset.mode === 'web';
