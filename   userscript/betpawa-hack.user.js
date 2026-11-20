// ==UserScript==
// @name         betPawa Console — round revealer
// @namespace    venice.betpawa
// @version      1.0.0
// @description  Taps the game WebSocket inside the provider iframe, paints safe cells, logs crash multipliers.
// @match        https://www.betpawa.ug/*
// @match        https://*.spribe.co/*
// @match        https://*.smartsoft.io/*
// @match        https://*.jellyentertainment.com/*
// @match        https://*.alea.com/*
// @match        https://*.blacklagoon.games/*
// @run-at       document-start
// @grant        none
// @allFrames    true
// ==/UserScript==

(function () {
  'use strict';
  if (window.__bpHack) return;
  window.__bpHack = { frames: [], boards: [], log: [] };
/* Console wiring. Set the URL once; it is remembered in localStorage. */
  let CONSOLE = localStorage.getItem('bpConsoleUrl') || '';
  if (!CONSOLE) {
    CONSOLE = (prompt('Console URL (e.g. https://your-app.onrender.com)') || '').replace(/\/+$/, '');
    if (CONSOLE) localStorage.setItem('bpConsoleUrl', CONSOLE);
  }
  const TOKEN = localStorage.getItem('bpIngestToken') || '';
  if (CONSOLE && !TOKEN && /onrender\.com/.test(CONSOLE)) {
    const t = prompt('Ingest token (Render env var INGEST_TOKEN)') || '';
    if (t) localStorage.setItem('bpIngestToken', t);
  }

  let pinned = [];
  async function loadConfig() {
    if (!CONSOLE) return;
    try {
      const r = await fetch(CONSOLE + '/api/config', { mode: 'cors' });
      const j = await r.json();
      pinned = (j.config && j.config.pinnedPaths) || [];
    } catch {}
  }
  loadConfig();
  setInterval(loadConfig, 15000);

  function upload(url, dir, raw) {
    if (!CONSOLE || !raw) return;
    fetch(CONSOLE + '/api/ingest' + (TOKEN ? '?t=' + encodeURIComponent(TOKEN) : ''), {
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: String(url || location.href), dir, raw: raw.slice(0, 60000) }),
      keepalive: true,
    }).catch(() => {});
  }
  /* ------------------------------------------------------------ WebSocket tap */

  const Native = window.WebSocket;
  if (Native) {
    const Patched = function (url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      window.__bpHack.log.push({ t: Date.now(), dir: 'open', url: String(url) });

      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') ingest(ev.data, 'in');
        else if (ev.data instanceof Blob) ev.data.text().then((s) => ingest(s, 'in')).catch(() => {});
        else if (ev.data instanceof ArrayBuffer) {
          try { ingest(new TextDecoder().decode(ev.data), 'in'); } catch {}
        }
      });

      const send = ws.send.bind(ws);
      ws.send = function (data) {
        if (typeof data === 'string') ingest(data, 'out');
        return send(data);
      };
      return ws;
    };
    Patched.prototype = Native.prototype;
    Patched.CONNECTING = Native.CONNECTING;
    Patched.OPEN = Native.OPEN;
    Patched.CLOSING = Native.CLOSING;
    Patched.CLOSED = Native.CLOSED;
    window.WebSocket = Patched;
  }

  /* ---------------------------------------------------------------- inspection */

  const BOARD_KEY = /tile|cell|safe|mine|bomb|tower|level|grid|row|board|field|step|state/i;
  const CRASH_KEY = /multiplier|multiplicator|coef|crash|payout|rate|odds/i;
  const HASH_KEY = /hash|seed|salt|verify|fair/i;

  function ingest(raw, dir) {
    if (!raw || raw.length > 200000) return;
    if (raw.length > 4000) return;              // keep the log readable
    window.__bpHack.log.push({ t: Date.now(), dir, raw });
    if (window.__bpHack.log.length > 400) window.__bpHack.log.shift();

    let data;
    try { data = JSON.parse(raw); } catch { return; }

    walk(data, []);
    schedulePaint();
  }

  /** Walk an object tree collecting arrays that look like a board and crash values. */
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      const hint = path[path.length - 1] || '';
      if (looksLikeBoard(node) && BOARD_KEY.test(hint)) {
        window.__bpHack.boards.push({ t: Date.now(), path: path.join('.'), cells: node });
        if (window.__bpHack.boards.length > 30) window.__bpHack.boards.shift();
      }
      node.forEach((v, i) => walk(v, path.concat(String(i))));
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      if (CRASH_KEY.test(k) && typeof v === 'number' && v > 1 && v < 5000) {
        window.__bpHack.boards.push({ t: Date.now(), path: path.concat(k).join('.'), crash: v });
      }
      if (HASH_KEY.test(k) && typeof v === 'string' && v.length > 8 && v.length < 200) {
        window.__bpHack.boards.push({ t: Date.now(), path: path.concat(k).join('.'), hash: v });
      }
      walk(v, path.concat(k));
    }
  }

  function looksLikeBoard(arr) {
    if (arr.length < 3 || arr.length > 40) return false;
    return arr.every((v) =>
      typeof v === 'boolean' ||
      (typeof v === 'number' && v >= 0 && v <= 9) ||
      (typeof v === 'string' && v.length <= 14)
    );
  }

  /* ------------------------------------------------------------------- paint */

  let queued = false;
  function schedulePaint() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }

  const isSafe = (v) =>
    v === true || v === 1 || /safe|good|win|up|ok|free/i.test(String(v));

  const isBad = (v) =>
    v === false || v === 0 || /mine|bomb|crash|bad|lose|down|boom/i.test(String(v));

  function render() {
    const hud = ensureHud();
    const body = hud.querySelector('.bp-body');
    const recent = window.__bpHack.boards.slice(-6).reverse();

    if (!recent.length) {
      body.innerHTML = '<div class="bp-dim">waiting for round data…</div>';
      return;
    }

    body.innerHTML = recent.map((b) => {
      if (b.crash) return `<div class="bp-line"><span class="bp-key">${esc(b.path)}</span>
        <span class="bp-num">${b.crash.toFixed(2)}x</span></div>`;
      if (b.hash) return `<div class="bp-line"><span class="bp-key">${esc(b.path)}</span>
        <code class="bp-hash">${esc(b.hash.slice(0, 22))}…</code></div>`;

      const chips = b.cells.map((v) => {
        const cls = isSafe(v) ? 'safe' : isBad(v) ? 'bad' : 'unk';
        return `<span class="bp-chip ${cls}">${esc(String(v))}</span>`;
      }).join('');
      return `<div class="bp-board"><span class="bp-key">${esc(b.path)}</span>
        <div class="bp-chips">${chips}</div></div>`;
    }).join('');
  }

  function ensureHud() {
    let hud = document.getElementById('bp-hud');
    if (hud) return hud;

    hud = document.createElement('div');
    hud.id = 'bp-hud';
    hud.innerHTML = `
      <style>
        #bp-hud{position:fixed;right:14px;bottom:14px;width:310px;max-height:56vh;z-index:2147483646;
          background:#0b0d0f;color:#e7ecef;border:1px solid #242b32;border-radius:12px;
          font:12px/1.45 ui-monospace,Menlo,monospace;box-shadow:0 12px 40px rgba(0,0,0,.6);
          display:flex;flex-direction:column;overflow:hidden}
        #bp-hud .bp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
          background:#14181c;border-bottom:1px solid #242b32;font-weight:700}
        #bp-hud .bp-head span{flex:1}
        #bp-hud .bp-head b{color:#9ce800}
        #bp-hud button{background:none;border:0;color:#8b979f;cursor:pointer;font:inherit;padding:2px 6px}
        #bp-hud .bp-body{padding:8px 10px;overflow:auto;display:flex;flex-direction:column;gap:8px}
        #bp-hud .bp-key{color:#8b979f;font-size:10.5px;word-break:break-all}
        #bp-hud .bp-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
        #bp-hud .bp-chip{min-width:22px;text-align:center;padding:2px 4px;border-radius:4px;
          background:#1b2126;border:1px solid #2a323a}
        #bp-hud .bp-chip.safe{background:rgba(156,232,0,.18);border-color:#9ce800;color:#9ce800;font-weight:700}
        #bp-hud .bp-chip.bad{background:rgba(255,77,77,.15);border-color:#ff4d4d;color:#ff4d4d}
        #bp-hud .bp-num{color:#9ce800;font-weight:700}
        #bp-hud .bp-hash{color:#ffb020}
        #bp-hud .bp-dim{color:#8b979f}
        #bp-hud.collapsed .bp-body{display:none}
      </style>
      <div class="bp-head"><b>●</b><span>bp revealer</span>
        <button class="bp-clr" title="clear">clear</button>
        <button class="bp-min" title="collapse">–</button></div>
      <div class="bp-body"><div class="bp-dim">waiting for round data…</div></div>`;
    document.documentElement.appendChild(hud);

    hud.querySelector('.bp-min').onclick = () => hud.classList.toggle('collapsed');
    hud.querySelector('.bp-clr').onclick = () => {
      window.__bpHack.boards = [];
      render();
    };
    return hud;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* -------------------------------------------------- console helpers for tuning */

  console.info('%c[betPawa revealer] armed', 'color:#9ce800;font-weight:700');
  console.info('inspect frames with: __bpHack.log   |   detected boards with: __bpHack.boards');
})();