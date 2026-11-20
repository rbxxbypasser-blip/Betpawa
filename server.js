'use strict';
/**
 * betPawa Console — proxy + live frame relay. Zero dependencies, Node 18+.
 *
 * Local:   node server.js  ->  http://localhost:8787
 * Render:  binds 0.0.0.0:$PORT automatically, /health for the health check.
 *
 * Env vars (all optional):
 *   PORT          listen port (Render injects it)
 *   BP_COOKIE     cookie header string, used to rehydrate the session on wake
 *   INGEST_TOKEN  if set, /api/ingest requires ?t= or x-ingest-token
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.betpawa.ug';
const PORT = Number(process.env.PORT || 8787);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.session.json');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

/* Auth/balance routes are probed, not hardcoded: the route map lives in a
 * webpack chunk and renames happen. First route that stops answering
 * error:NOT_FOUND wins and is cached. */
const AUTH_CANDIDATES = [
  '/api/user/authenticate',
  '/api/v1/user/authenticate',
  '/api/client/user/authenticate',
  '/api/v1/authenticate',
  '/api/auth/authenticate',
  '/api/authenticate',
  '/api/user/login',
  '/api/v1/user/login',
];
const BALANCE_CANDIDATES = [
  '/api/user/balance',
  '/api/v1/user/balance',
  '/api/wallet/balance',
  '/api/v1/wallet/balance',
];

/* ------------------------------------------------------------------- state */

let state = { cookies: {}, authPath: null, balancePath: null, user: null };

try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}

if (process.env.BP_COOKIE) {
  for (const pair of process.env.BP_COOKIE.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) state.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  state.user = state.user || { phone: 'from BP_COOKIE', userUuid: null };
}

const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {} };

const cookieHeader = () =>
  Object.entries(state.cookies).map(([k, v]) => `${k}=${v}`).join('; ');

function absorbCookies(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return;
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    if (/expires=Thu, 01 Jan 1970/i.test(line)) delete state.cookies[name];
    else state.cookies[name] = pair.slice(idx + 1).trim();
  }
  save();
}

/* ---------------------------------------------------------- captured frames */

const MAX_FRAMES = 1500;
const frames = [];
let frameSeq = 0;
let config = { pinnedPaths: [], note: '' };

function recordFrame({ url, dir, raw }) {
  if (typeof raw !== 'string' || !raw) return null;
  const trimmed = raw.length > 60000 ? raw.slice(0, 60000) : raw;
  const frame = { id: ++frameSeq, ts: Date.now(), dir: dir === 'out' ? 'out' : 'in', url: url || '', raw: trimmed };
  frames.push(frame);
  if (frames.length > MAX_FRAMES) frames.shift();
  return frame;
}

/** Surface arrays/keys that could be a board so the console can offer them. */
function candidatesOf(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const out = [];
  (function walk(node, p) {
    if (out.length > 60 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (
        node.length >= 2 && node.length <= 40 &&
        node.every((v) => typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')
      ) {
        out.push({ path: p.join('.'), kind: 'array', sample: node.slice(0, 12) });
      }
      node.forEach((v, i) => walk(v, p.concat(String(i))));
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, p.concat(k));
  })(data, []);
  return out;
}

/* ---------------------------------------------------------------- upstream */

function bp(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const url = new URL(ORIGIN + pathname);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-UG,en;q=0.9',
        origin: ORIGIN,
        referer: ORIGIN + '/login',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(cookieHeader() ? { cookie: cookieHeader() } : {}),
        ...headers,
      },
    }, (res) => {
      absorbCookies(res.headers);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const isRouteMiss = (r) => r.status === 404 && /"error"\s*:\s*"NOT_FOUND"/.test(r.body);
const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

async function discover(candidates, method, bodyFor) {
  for (const p of candidates) {
    try {
      const r = await bp(method, p, bodyFor ? { body: bodyFor() } : {});
      if (!isRouteMiss(r)) return { path: p, response: r };
    } catch { /* try next */ }
  }
  return null;
}

/* -------------------------------------------------------------------- http */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-ingest-token',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(obj));
};

const readBody = async (req, limit = 1000000) => {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
};

async function handleLogin(res, body) {
  const { phone, password, rememberMe = true, captchaToken } = body;
  if (!phone || !password) return json(res, 400, { ok: false, error: 'phone and password required' });

  const attempt = (p) => {
    const headers = {};
    if (captchaToken) {
      headers['x-turnstile-token'] = captchaToken;
      headers['cf-turnstile-response'] = captchaToken;
    }
    return bp('POST', p, { body: { username: phone, password, rememberMe }, headers });
  };

  let target = state.authPath;
  let r;

  if (target) {
    r = await attempt(target);
    if (isRouteMiss(r)) target = null;
  }
  if (!target) {
    const found = await discover(AUTH_CANDIDATES, 'POST', () => ({ username: phone, password, rememberMe }));
    if (!found) return json(res, 502, { ok: false, error: 'no auth route answered', tried: AUTH_CANDIDATES });
    target = found.path;
    state.authPath = target;
    r = found.response;
  }

  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch {}

  if (r.status >= 400 || !parsed || parsed.error) {
    return json(res, 401, { ok: false, route: target, status: r.status, upstream: parsed || r.body.slice(0, 400) });
  }

  state.user = { userUuid: parsed.userUuid || null, phone };
  save();
  json(res, 200, { ok: true, route: target, userUuid: state.user.userUuid });
}

async function handleCookie(res, body) {
  const raw = String(body.cookie || '').trim();
  if (!raw) return json(res, 400, { ok: false, error: 'cookie required' });

  state.cookies = {};
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) state.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  state.user = { phone: 'cookie session', userUuid: null };
  save();

  const probe = await bp('GET', state.balancePath || '/api/user/balance');
  json(res, 200, { ok: true, cookieNames: Object.keys(state.cookies), balanceStatus: probe.status });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* -------------------------------------------------------------------- main */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = url.searchParams;
  const p = url.pathname;

  try {
    if (p === '/health') return json(res, 200, { ok: true });

    if (p === '/api/ingest' || p === '/api/config') {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    }

    if (p === '/api/status') {
      return json(res, 200, {
        ok: true,
        loggedIn: Boolean(state.user),
        user: state.user,
        authPath: state.authPath,
        balancePath: state.balancePath,
        frames: frameSeq,
        ingestTokenRequired: Boolean(INGEST_TOKEN),
      });
    }

    if (p === '/api/login' && req.method === 'POST') {
      return handleLogin(res, JSON.parse((await readBody(req)) || '{}'));
    }

    if (p === '/api/cookie' && req.method === 'POST') {
      return handleCookie(res, JSON.parse((await readBody(req)) || '{}'));
    }

    if (p === '/api/logout') {
      state = { cookies: {}, authPath: state.authPath, balancePath: state.balancePath, user: null };
      save();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/balance') {
      let target = state.balancePath;
      if (!target) {
        const found = await discover(BALANCE_CANDIDATES, 'GET');
        if (!found) return json(res, 404, { ok: false, error: 'no balance route' });
        target = found.path;
        state.balancePath = target;
        save();
        return json(res, 200, { ok: true, route: target, raw: safeJson(found.response.body) });
      }
      const r = await bp('GET', target);
      return json(res, 200, { ok: r.status < 400, route: target, raw: safeJson(r.body) });
    }

    if (p === '/api/bp') {
      const target = q.get('path');
      if (!target || !target.startsWith('/')) return json(res, 400, { ok: false, error: 'path= required' });
      const r = await bp((q.get('method') || 'GET').toUpperCase(), target);
      return json(res, 200, { ok: r.status < 400, status: r.status, raw: safeJson(r.body) });
    }

    /* ---- capture relay (token optional) ---- */
    if (p === '/api/ingest' && req.method === 'POST') {
      if (INGEST_TOKEN) {
        const supplied = q.get('t') || req.headers['x-ingest-token'];
        if (supplied !== INGEST_TOKEN) return json(res, 401, { ok: false, error: 'bad token' }, CORS);
      }
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }, CORS); }
      const frame = recordFrame(body);
      if (!frame) return json(res, 200, { ok: true, skipped: true }, CORS);
      return json(res, 200, { ok: true, id: frame.id, candidates: candidatesOf(frame.raw) }, CORS);
    }

    if (p === '/api/frames') {
      const since = Number(q.get('since') || 0);
      const fresh = frames.filter((f) => f.id > since).slice(-200);
      return json(res, 200, { ok: true, frames: fresh, last: frameSeq }, CORS);
    }

    if (p === '/api/frames/clear') {
      frames.length = 0;
      return json(res, 200, { ok: true });
    }

    if (p === '/api/config') {
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        config = {
          pinnedPaths: Array.isArray(body.pinnedPaths) ? body.pinnedPaths.slice(0, 12) : config.pinnedPaths,
          note: typeof body.note === 'string' ? body.note.slice(0, 400) : config.note,
        };
        return json(res, 200, { ok: true, config }, CORS);
      }
      return json(res, 200, { ok: true, config }, CORS);
    }

    serveStatic(res, p);
  } catch (err) {
    json(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`listening on ${HOST}:${PORT}`);
  console.log(state.authPath ? `cached auth route: ${state.authPath}` : 'auth route: will probe on first login');
  if (INGEST_TOKEN) console.log('ingest token required');
  else console.log('ingest open (no INGEST_TOKEN set)');
});