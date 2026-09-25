/**
 * GhostLink Desktop — Custom Title Bar
 *
 * This file is injected into the renderer process via executeJavaScript.
 * It creates a frameless, draggable title bar with window controls
 * that matches the GhostLink dark theme.
 *
 * The placeholder __WINDOW_TITLE__ is replaced at injection time.
 */

(function () {
  if (document.getElementById('gl-titlebar')) return;

  const TITLE = '__WINDOW_TITLE__';
  const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

  /* ─── Create title bar container ──────────────────────────── */
  const bar = document.createElement('div');
  bar.id = 'gl-titlebar';

  /* ─── Styles ──────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    #gl-titlebar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 38px;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, #0d0d14 0%, #111120 100%);
      border-bottom: 1px solid rgba(0, 255, 200, 0.08);
      -webkit-app-region: drag;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 0;
      box-shadow: 0 1px 8px rgba(0, 0, 0, 0.4);
    }

    #gl-titlebar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-left: ${IS_MAC ? '78px' : '14px'};
      height: 100%;
    }

    #gl-titlebar-icon {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      background: linear-gradient(135deg, #00ffc8, #00bfa6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 900;
      color: #0a0a0f;
      flex-shrink: 0;
      box-shadow: 0 0 8px rgba(0, 255, 200, 0.25);
    }

    #gl-titlebar-title {
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }

    /* ── Window controls (right side, Windows/Linux) ─────────── */
    #gl-titlebar-controls {
      display: ${IS_MAC ? 'none' : 'flex'};
      align-items: center;
      height: 100%;
      -webkit-app-region: no-drag;
    }

    .gl-titlebar-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      height: 100%;
      background: transparent;
      border: none;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.55);
      transition: background 0.15s, color 0.15s;
      font-size: 14px;
      -webkit-app-region: no-drag;
      outline: none;
    }

    .gl-titlebar-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.9);
    }

    .gl-titlebar-btn.close:hover {
      background: #e81123;
      color: #fff;
    }

    .gl-titlebar-btn svg {
      width: 10px;
      height: 10px;
      stroke: currentColor;
      stroke-width: 1.5;
      fill: none;
    }
  `;
  document.head.appendChild(style);

  /* ─── Build HTML ──────────────────────────────────────────── */
  bar.innerHTML = `
    <div id="gl-titlebar-left">
      <div id="gl-titlebar-icon">G</div>
      <span id="gl-titlebar-title"></span>
    </div>

    <div style="display: flex; align-items: center; height: 100%;">
      <div id="gl-titlebar-controls">
        <button class="gl-titlebar-btn minimize" title="Minimize">
          <svg viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5"/></svg>
        </button>
        <button class="gl-titlebar-btn maximize" title="Maximize">
          <svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" rx="1"/></svg>
        </button>
        <button class="gl-titlebar-btn close" title="Close">
          <svg viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10"/>
            <line x1="10" y1="0" x2="0" y2="10"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  // textContent, not markup: the title is data and must never be parsed.
  bar.querySelector('#gl-titlebar-title').textContent = TITLE;

  document.body.prepend(bar);

  /* ─── Wire up controls ────────────────────────────────────── */
  const api = window.ghostlink;
  if (api) {
    bar.querySelector('.minimize')?.addEventListener('click', () => api.minimize());
    bar.querySelector('.maximize')?.addEventListener('click', () => api.maximize());
    bar.querySelector('.close')?.addEventListener('click', () => api.close());
  }

  /* ─── Double-click titlebar to maximize ───────────────────── */
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.gl-titlebar-btn')) return;
    if (api) api.maximize();
  });
})();
