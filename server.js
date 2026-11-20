#!/usr/bin/env node
'use strict';
/**
 * betPawa Console — local proxy. Zero dependencies, Node 18+.
 *
 * Why a server at all: betpawa.ug sends no CORS headers, so a browser page on
 * another origin cannot call their API. This proxies it and holds the cookie
 * jar server-side so the browser never sees the session cookie.
 *
 *   node server.js          ->  http://localhost:8787
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.betpawa.ug';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.session.json');

/* Candidate auth routes. The route map lives inside a webpack chunk we could not
 * extract statically, so instead of guessing once we probe in order and remember
 * whichever route stops answering NOT_FOUND. A 200/400/401/403 all count as
 * "this route exists"; only a 404 with error:NOT_FOUND is a miss. */
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

let state = { cookies: {}, authPath: null, balancePath: null, user: null };

try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch { /* first run */ }

const save = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
};

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
    const value = pair.slice(idx + 1).trim();
    if (/expires=Thu, 01 Jan 1970/i.test(line)) delete state.cookies[name];
    else state.cookies[name] = value;
  }
  save();
}

/** Low-level request against the origin. Resolves {status, headers, body}. */
function bp(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body)
    );
    const url = new URL(ORIGIN + pathname);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-UG,en;q=0.9',
        'origin': ORIGIN,
        'referer': ORIGIN + '/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const isRouteMiss = (r) =>
  r.status === 404 && /"error"\s*:\s*"NOT_FOUND"/.test(r.body);

/** Probe candidates until one answers something other than NOT_FOUND. */
async function discover(candidates, method, bodyFor) {
  for (const p of candidates) {
    try {
      const r = await bp(method, p, bodyFor ? { body: bodyFor() } : {});
      if (!isRouteMiss(r)) return { path: p, response: r };
    } catch { /* try next */ }
  }
  return null;
}

/* ------------------------------------------------------------------ routes */

const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(s);
};

async function handleLogin(res, body) {
  const { phone, password, rememberMe = true, captchaToken } = body;
  if (!phone || !password) return json(res, 400, { ok: false, error: 'phone and password required' });

  const attempt = async (p) => {
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
    if (isRouteMiss(r)) { target = null; }
  }
  if (!target) {
    const found = await discover(AUTH_CANDIDATES, 'POST', () => ({ username: phone, password, rememberMe }));
    if (!found) return json(res, 502, {
      ok: false,
      error: 'No auth route answered. All candidates 404. Paste cookies instead (see README).',
      tried: AUTH_CANDIDATES,
    });
    target = found.path;
    state.authPath = target;
    r = found.response;
  }

  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch {}

  const ok = r.status < 400 && parsed && !parsed.error;
  if (!ok) return json(res, 401, {
    ok: false, route: target, status: r.status, upstream: parsed || r.body.slice(0, 400),
  });

  state.user = { userUuid: parsed.userUuid || parsed.uuid || null, phone };
  save();
  json(res, 200, { ok: true, route: target, userUuid: state.user.userUuid });
}

async function handleBalance(res) {
  let p = state.balancePath;
  if (!p) {
    const found = await discover(BALANCE_CANDIDATES, 'GET');
    if (!found) return json(res, 404, { ok: false, error: 'no balance route' });
    p = found.path; state.balancePath = p; save();
    return json(res, 200, { ok: true, route: p, raw: safeJson(found.response.body) });
  }
  const r = await bp('GET', p);
  json(res, 200, { ok: true, route: p, raw: safeJson(r.body) });
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

async function handleProxy(res, q) {
  const p = q.get('path');
  if (!p || !p.startsWith('/')) return json(res, 400, { ok: false, error: 'path= required' });
  const method = (q.get('method') || 'GET').toUpperCase();
  const r = await bp(method, p);
  json(res, 200, { ok: r.status < 400, status: r.status, raw: safeJson(r.body) });
}

/* ------------------------------------------------------------------ static */

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
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;

  try {
    if (url.pathname === '/api/status') {
      return json(res, 200, {
        ok: true,
        loggedIn: Boolean(state.user),
        user: state.user,
        authPath: state.authPath,
        balancePath: state.balancePath,
      });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return handleLogin(res, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    }
    if (url.pathname === '/api/logout') {
      state = { cookies: {}, authPath: state.authPath, balancePath: state.balancePath, user: null };
      save();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/balance') return handleBalance(res);
    if (url.pathname === '/api/bp') return handleProxy(res, q);

    serveStatic(res, url.pathname);
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`betPawa console -> http://localhost:${PORT}`);
  console.log(state.authPath ? `cached auth route: ${state.authPath}` : 'auth route: will probe on first login');
});