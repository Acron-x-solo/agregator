'use strict';

// Веб-панель управления Claude Code. Отдельный HTTP-сервер (свой порт),
// защищённый токеном — именно его публикует Cloudflare Tunnel наружу.
// Прокси Anthropic и локальная админка ключей наружу НЕ выставляются.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const COOKIE = 'ccpanel';
const MAX_BODY = 2 * 1024 * 1024;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createWebPanel({ root, getCfg, save, log, control, telegram, tunnel, agg, adminApi }) {
  const gate = new Map(); // ip -> { fails, until }
  const clients = new Set();
  let server = null;
  const pending = new Map(); // sessionId -> накопленные дельты

  const conf = () => (getCfg().control || {});

  function sigFor(token) {
    const salt = String(conf().cookieSalt || '');
    return crypto.createHash('sha256').update(String(token) + '|' + salt).digest('hex');
  }

  function ipOf(req) {
    return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim();
  }
  function locked(req) {
    const g = gate.get(ipOf(req));
    return !!(g && g.until > Date.now());
  }

  function noteFail(req) {
    const ip = ipOf(req);
    const g = gate.get(ip) || { fails: 0, until: 0 };
    g.fails++;
    if (g.fails >= 8) {
      g.until = Date.now() + 5 * 60 * 1000;
      g.fails = 0;
      log('warn', `панель: 8 неудачных входов с ${ip || 'неизвестного адреса'} — блок на 5 минут`);
    }
    gate.set(ip, g);
  }

  function noteOk(req) {
    gate.delete(ipOf(req));
  }

  // Вход по ссылке /?t=<токен> (и /keys?t=…). Панель торчит наружу через
  // Cloudflare, поэтому неудачные попытки считаем так же, как на /api/login —
  // иначе токен можно спокойно перебирать по URL.
  function tryTokenLogin(req, res, u, to) {
    const t = u.searchParams.get('t');
    if (!t) return false;
    if (locked(req)) {
      res.writeHead(429, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      res.end('слишком много попыток, подожди 5 минут');
      return true;
    }
    const token = String(conf().token || '');
    if (token && safeEqual(t, token)) {
      noteOk(req);
      setCookie(res, req, token);
      log('info', 'панель: вход по ссылке (' + (ipOf(req) || 'local') + ')');
      res.writeHead(302, baseHeaders({ location: to }));
      res.end();
      return true;
    }
    noteFail(req);
    return false;
  }

  function authed(req) {
    const token = String(conf().token || '');
    if (!token) return false;
    const c = parseCookies(req.headers.cookie);
    if (c[COOKIE] && safeEqual(c[COOKIE], sigFor(token))) return true;
    const h = req.headers['x-panel-token'];
    if (h && safeEqual(h, token)) return true;
    return false;
  }

  function baseHeaders(extra) {
    return Object.assign({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store'
    }, extra || {});
  }

  function sendJson(res, code, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length }));
    res.end(buf);
  }

  function setCookie(res, req, token) {
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.headers['cf-connecting-ip'];
    res.setHeader('set-cookie', `${COOKIE}=${sigFor(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure ? '; Secure' : ''}`);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); reject(new Error('слишком большое тело запроса')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('невалидный JSON')); }
      });
      req.on('error', reject);
    });
  }
  function broadcast(ev) {
    if (!clients.size) return;
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of clients) {
      try { res.write(line); } catch (e) { clients.delete(res); }
    }
  }

  // Дельты приходят посимвольно — склеиваем и отправляем пачками 4 раза в секунду.
  control.onEvent(ev => {
    if (ev.t === 'delta') {
      pending.set(ev.sessionId, (pending.get(ev.sessionId) || '') + ev.text);
      return;
    }
    if (ev.t === 'msg' || ev.t === 'session' || ev.t === 'removed') flushDeltas();
    broadcast(ev);
  });

  function flushDeltas() {
    if (!pending.size) return;
    for (const [sessionId, text] of pending) broadcast({ t: 'delta', sessionId, text });
    pending.clear();
  }
  setInterval(flushDeltas, 250).unref();
  setInterval(() => broadcast({ t: 'ping', at: Date.now() }), 20000).unref();

  if (tunnel && tunnel.onEvent) tunnel.onEvent(s => broadcast({ t: 'tunnel', tunnel: s }));

  function snapshot() {
    const c = conf();
    return {
      sessions: control.list(),
      stats: control.stats(),
      defaults: {
        defaultCwd: c.defaultCwd || root,
        defaultModel: c.defaultModel || '',
        permissionMode: c.permissionMode || 'acceptEdits',
        defaultEffort: c.defaultEffort || '',
        stream: c.stream !== false,
        turnTimeoutMs: c.turnTimeoutMs || 1800000,
        claudeBin: c.claudeBin || 'claude'
      },
      panel: {
        port: c.port,
        localUrl: 'http://127.0.0.1:' + c.port + '/',
        keysPath: '/keys',
        token: c.token
      },
      telegram: telegram ? telegram.status() : null,
      tunnel: tunnel ? tunnel.status() : null,
      cloudflare: {
        enabled: (c.cloudflare || {}).enabled !== false,
        mode: (c.cloudflare || {}).mode || 'quick',
        hostname: (c.cloudflare || {}).hostname || '',
        hasToken: !!String((c.cloudflare || {}).tunnelToken || '').trim(),
        autoRestart: (c.cloudflare || {}).autoRestart !== false
      },
      autoPing: agg && agg.autoPing ? agg.autoPing() : null,
      aggregator: agg ? agg.summary() : null
    };
  }

  function serveFile(res, file, type) {
    fs.readFile(path.join(root, 'public', file), (err, buf) => {
      if (err) return sendJson(res, 500, { error: file + ' не найден' });
      res.writeHead(200, baseHeaders({ 'content-type': type, 'content-length': buf.length }));
      res.end(buf);
    });
  }

  async function handleApi(req, res, u) {
    const p = u.pathname;
    const q = u.searchParams;

    if (p === '/api/login' && req.method === 'POST') {
      if (locked(req)) return sendJson(res, 429, { error: 'слишком много попыток, подожди 5 минут' });
      const body = await readJson(req).catch(() => ({}));
      const token = String(conf().token || '');
      if (token && safeEqual(body.token, token)) {
        noteOk(req);
        setCookie(res, req, token);
        log('info', 'панель: вход выполнен (' + (ipOf(req) || 'local') + ')');
        return sendJson(res, 200, { ok: true });
      }
      noteFail(req);
      return sendJson(res, 401, { error: 'неверный токен' });
    }

    if (!authed(req)) return sendJson(res, 401, { error: 'нужен вход' });

    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, snapshot());

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, baseHeaders({
        'content-type': 'text/event-stream; charset=utf-8',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      }));
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify({ t: 'hello', state: snapshot() }) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/browse' && req.method === 'GET') {
      try { return sendJson(res, 200, control.browse(q.get('path') || '')); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      try { return sendJson(res, 201, control.createSession(body)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    const m = p.match(/^\/api\/sessions\/([\w-]+)(?:\/(prompt|stop|clear|history))?$/);
    if (m) {
      const id = m[1];
      const action = m[2];
      if (!control.get(id)) return sendJson(res, 404, { error: 'сессия не найдена' });
      try {
        if (!action && req.method === 'PATCH') return sendJson(res, 200, control.patchSession(id, await readJson(req)));
        if (!action && req.method === 'DELETE') return sendJson(res, 200, { ok: control.deleteSession(id) });
        if (action === 'history' && req.method === 'GET') return sendJson(res, 200, control.history(id));
        if (action === 'prompt' && req.method === 'POST') {
          const body = await readJson(req);
          return sendJson(res, 200, control.sendPrompt(id, body.text, 'web'));
        }
        if (action === 'stop' && req.method === 'POST') return sendJson(res, 200, control.stop(id, 'остановлено из панели'));
        if (action === 'clear' && req.method === 'POST') return sendJson(res, 200, control.clearSession(id));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      const c = getCfg().control;
      if (typeof body.defaultCwd === 'string' && body.defaultCwd.trim()) {
        try { fs.statSync(body.defaultCwd); c.defaultCwd = body.defaultCwd.trim(); }
        catch (e) { return sendJson(res, 400, { error: 'папка не найдена: ' + body.defaultCwd }); }
      }
      if (typeof body.defaultModel === 'string') c.defaultModel = body.defaultModel.trim();
      if (control.PERMISSION_MODES.includes(body.permissionMode)) c.permissionMode = body.permissionMode;
      if (control.EFFORTS.includes(body.defaultEffort)) c.defaultEffort = body.defaultEffort;
      if (typeof body.stream === 'boolean') c.stream = body.stream;
      if (Number.isFinite(body.turnTimeoutMs)) c.turnTimeoutMs = Math.max(60000, body.turnTimeoutMs | 0);
      if (typeof body.claudeBin === 'string' && body.claudeBin.trim()) c.claudeBin = body.claudeBin.trim();
      if (body.telegram && typeof body.telegram === 'object') {
        const t = c.telegram;
        if (typeof body.telegram.botToken === 'string') t.botToken = body.telegram.botToken.trim();
        if (typeof body.telegram.enabled === 'boolean') t.enabled = body.telegram.enabled;
        if (Array.isArray(body.telegram.allowedChatIds)) t.allowedChatIds = body.telegram.allowedChatIds.map(String).filter(Boolean);
        if (typeof body.telegram.pairingCode === 'string') t.pairingCode = body.telegram.pairingCode.trim();
        if (typeof body.telegram.proxy === 'string') {
          const v = body.telegram.proxy.trim();
          // Пустая строка = без прокси; иначе адрес обязан быть разборчивым.
          if (v) {
            try { require('./proxy').checkProxy(v); }
            catch (e) { return sendJson(res, 400, { error: 'прокси: ' + e.message }); }
          }
          t.proxy = v;
        }
      }
      if (body.cloudflare && typeof body.cloudflare === 'object') {
        const f = c.cloudflare;
        if (typeof body.cloudflare.enabled === 'boolean') f.enabled = body.cloudflare.enabled;
        if (['quick', 'token'].includes(body.cloudflare.mode)) f.mode = body.cloudflare.mode;
        if (typeof body.cloudflare.tunnelToken === 'string') f.tunnelToken = body.cloudflare.tunnelToken.trim();
        if (typeof body.cloudflare.hostname === 'string') f.hostname = body.cloudflare.hostname.trim();
        if (typeof body.cloudflare.cloudflaredPath === 'string') f.cloudflaredPath = body.cloudflare.cloudflaredPath.trim();
        if (typeof body.cloudflare.autoRestart === 'boolean') f.autoRestart = body.cloudflare.autoRestart;
      }
      save();
      log('info', 'панель: настройки сохранены');
      broadcast({ t: 'state', state: snapshot() });
      return sendJson(res, 200, snapshot());
    }
    if (p === '/api/telegram/start' && req.method === 'POST') {
      const r = await telegram.start();
      broadcast({ t: 'state', state: snapshot() });
      return sendJson(res, 200, r);
    }
    if (p === '/api/telegram/stop' && req.method === 'POST') {
      const r = telegram.stop();
      broadcast({ t: 'state', state: snapshot() });
      return sendJson(res, 200, r);
    }
    if (p === '/api/telegram/revoke' && req.method === 'POST') {
      const body = await readJson(req);
      telegram.revoke(body.chatId);
      return sendJson(res, 200, telegram.status());
    }

    if (p.startsWith('/api/tunnel/') && req.method === 'POST') {
      const act = p.split('/')[3];
      const target = 'http://127.0.0.1:' + conf().port;
      let r;
      if (act === 'start') r = tunnel.start(target);
      else if (act === 'stop') r = tunnel.stop();
      else if (act === 'restart') r = tunnel.restart(target);
      else return sendJson(res, 404, { error: 'не найдено' });
      return sendJson(res, 200, r);
    }

    if (p === '/api/agg' && req.method === 'GET') {
      return sendJson(res, 200, agg ? agg.summary() : { error: 'нет данных' });
    }
    if (p.match(/^\/api\/agg\/providers\/([\w-]+)\/(activate|test)$/) && req.method === 'POST') {
      const parts = p.split('/');
      const id = parts[4];
      const act = parts[5];
      if (!agg) return sendJson(res, 400, { error: 'недоступно' });
      if (act === 'test') {
        if (!agg.testOne) return sendJson(res, 400, { error: 'недоступно' });
        return agg.testOne(id, r => {
          broadcast({ t: 'agg', aggregator: agg.summary() });
          sendJson(res, r && r.error ? 400 : 200, r);
        });
      }
      const r = agg.activate(id);
      broadcast({ t: 'state', state: snapshot() });
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/agg/test-all' && req.method === 'POST') {
      if (!agg) return sendJson(res, 400, { error: 'недоступно' });
      return agg.testAll(r => {
        broadcast({ t: 'agg', aggregator: agg.summary() });
        sendJson(res, 200, r);
      });
    }
    if (p === '/api/agg/ping-now' && req.method === 'POST') {
      if (!agg || !agg.pingNow) return sendJson(res, 400, { error: 'недоступно' });
      return agg.pingNow(r => {
        broadcast({ t: 'agg', aggregator: agg.summary() });
        sendJson(res, 200, { run: r, autoPing: agg.autoPing ? agg.autoPing() : null });
      });
    }
    if (p === '/api/agg/reset-all' && req.method === 'POST') {
      if (!agg || !agg.resetAll) return sendJson(res, 400, { error: 'недоступно' });
      const r = agg.resetAll();
      broadcast({ t: 'agg', aggregator: agg.summary() });
      return sendJson(res, 200, r);
    }
    if (p === '/api/agg/autoping' && req.method === 'POST') {
      if (!agg || !agg.setAutoPing) return sendJson(res, 400, { error: 'недоступно' });
      const body = await readJson(req);
      const r = agg.setAutoPing(body);
      broadcast({ t: 'state', state: snapshot() });
      return sendJson(res, 200, r);
    }


    return sendJson(res, 404, { error: 'не найдено' });
  }
  // Админка ключей агрегатора, опубликованная через ту же панель (и тот же токен).
  // Сам агрегатор слушает только 127.0.0.1, наружу он не торчит.
  function handleKeys(req, res, u) {
    const rest = u.pathname.slice('/keys'.length) || '/';
    if (req.method === 'GET' && (rest === '/' || rest === '/index.html')) {
      if (tryTokenLogin(req, res, u, '/keys')) return;
    }
    if (!authed(req)) {
      if (rest.startsWith('/api/')) return sendJson(res, 401, { error: 'нужен вход' });
      res.writeHead(302, baseHeaders({ location: '/' }));
      return res.end();
    }
    if (rest.startsWith('/api/')) {
      if (!adminApi) return sendJson(res, 400, { error: 'админка ключей недоступна' });
      Promise.resolve()
        .then(() => adminApi(req, res, rest, u.searchParams))
        .catch(e => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
      return;
    }
    if (rest === '/' || rest === '/index.html') return serveFile(res, 'index.html', 'text/html; charset=utf-8');
    res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.end('not found');
  }

  function onRequest(req, res) {
    let u;
    try {
      u = new URL(req.url, 'http://panel');
    } catch (e) {
      return sendJson(res, 400, { error: 'плохой адрес' });
    }
    const p = u.pathname;

    if (p === '/keys' || p.startsWith('/keys/')) return handleKeys(req, res, u);

    if (p.startsWith('/api/')) {
      handleApi(req, res, u).catch(e => {
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
      });
      return;
    }

    // Вход по ссылке с токеном: /?t=<token> — ставим cookie и убираем токен из URL.
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (tryTokenLogin(req, res, u, '/')) return;
      return serveFile(res, 'control.html', 'text/html; charset=utf-8');
    }

    if (p === '/favicon.ico') {
      res.writeHead(204, baseHeaders());
      return res.end();
    }
    res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.end('not found');
  }

  function start() {
    if (server) return { running: true, port: conf().port };
    const c = conf();
    server = http.createServer(onRequest);
    server.on('error', e => {
      log('warn', 'панель: не удалось поднять сервер — ' + e.message +
        (e.code === 'EADDRINUSE' ? ' (порт ' + c.port + ' занят)' : ''));
      server = null;
    });
    server.listen(c.port, c.host || '127.0.0.1', () => {
      log('info', `панель управления: http://${c.host || '127.0.0.1'}:${c.port}/?t=${c.token}`);
    });
    return { running: true, port: c.port };
  }

  function stop() {
    if (server) { try { server.close(); } catch (e) {} server = null; }
    for (const res of clients) { try { res.end(); } catch (e) {} }
    clients.clear();
  }

  return { start, stop, snapshot, broadcast, isRunning: () => !!server };
}

module.exports = { createWebPanel };

