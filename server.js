'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

const { createControl } = require('./lib/control');
const { createTunnel } = require('./lib/tunnel');
const { createTelegramBot } = require('./lib/telegram');
const { createWebPanel } = require('./lib/webpanel');
const { createHealthcheck, normalizeAutoPing } = require('./lib/healthcheck');


const CONTROL_DEFAULTS = {
  enabled: true,
  port: 8788,
  host: '127.0.0.1',
  token: '',
  cookieSalt: '',
  claudeBin: 'claude',
  defaultCwd: '',
  defaultModel: '',
  permissionMode: 'acceptEdits',
  defaultEffort: '',
  stream: true,
  turnTimeoutMs: 30 * 60 * 1000,
  extraArgs: [],
  env: {},
  telegram: {
    enabled: false,
    botToken: '',
    pairingCode: '',
    proxy: '',
    allowedChatIds: [],
    bindings: {}
  },
  cloudflare: {
    enabled: false,
    mode: 'quick',
    tunnelToken: '',
    hostname: '',
    cloudflaredPath: 'cloudflared',
    autoRestart: true,
    autoStart: true
  }
};

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  strategy: 'priority',
  cooldownMs: 60000,
  downCooldownMs: 30000,
  maxFailures: 3,
  autoRetryDown: false,
  activeId: null,
  defaultModel: 'claude-opus-4-8',
  models: ['claude-opus-4-8', 'claude-opus-5'],
  autoPing: {},
  providers: [],
  control: CONTROL_DEFAULTS
};

// Один пул соединений на весь апстрим-трафик: меньше TLS-хендшейков,
// заметно стабильнее на длинных стримах и на пачках проверок ключей.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 32 });
const agentFor = proto => (proto === 'https:' ? httpsAgent : httpAgent);


const RETRY_STATUS = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504, 529]);
const BILLING_HINTS = ['credit', 'balance', 'billing', 'quota', 'insufficient', 'arrears', 'arrearage'];

// Ошибки, при которых просят «повторить запрос сразу» (без переключения на
// другой провайдер). 529 — Cloudflare «сайт перегружен»; 500 с телом
// «upstream error: do request failed» — туннель временно упал. В обоих
// случаях имеет смысл немедленно повторить тот же самый запрос тому же
// провайдеру, прежде чем отказываться и уходить на следующий в цепочке.
const IMMEDIATE_RETRY_CODES = new Set([529]);
const MAX_IMMEDIATE_RETRIES = 3;

function isImmediateRetryable(st, msg) {
  if (IMMEDIATE_RETRY_CODES.has(st)) return true;
  if (st === 500 && /upstream error:\s*do request failed/i.test(String(msg || ''))) return true;
  return false;
}

const state = {
  rr: 0,
  lastSeenModel: null,
  logs: [],
  logSeq: 0,
  selfWriteAt: 0,
  stats: { requests: 0, failovers: 0, startedAt: Date.now() }
};

// Сервисы удалённого управления (создаются после старта прокси).
let control = null;
let tunnel = null;
let tgBot = null;
let panel = null;
let health = null;


let cfg = loadConfig();

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const c = normalize(raw);
    // Блок control мог отсутствовать (старый конфиг) — сразу закрепляем
    // сгенерированные токен/соль на диске, иначе они менялись бы при каждом старте.
    const rc = raw && raw.control;
    if (!rc || rc.token !== c.control.token || rc.cookieSalt !== c.control.cookieSalt) persist(c);
    return c;
  } catch (e) {
    const c = normalize({});
    persist(c);
    return c;
  }
}

function normalizeControl(raw) {
  const c = Object.assign({}, CONTROL_DEFAULTS, raw || {});
  c.telegram = Object.assign({}, CONTROL_DEFAULTS.telegram, (raw && raw.telegram) || {});
  c.cloudflare = Object.assign({}, CONTROL_DEFAULTS.cloudflare, (raw && raw.cloudflare) || {});
  c.port = Number.isFinite(c.port) ? (c.port | 0) : 8788;
  c.host = c.host || '127.0.0.1';
  // Токен панели и соль для cookie генерируются один раз и живут в config.json.
  if (!c.token || String(c.token).length < 24) c.token = crypto.randomBytes(18).toString('base64url');
  if (!c.cookieSalt) c.cookieSalt = crypto.randomBytes(16).toString('hex');
  if (!c.defaultCwd) c.defaultCwd = path.join(require('os').homedir(), 'Desktop');
  if (!Array.isArray(c.extraArgs)) c.extraArgs = [];
  if (!c.env || typeof c.env !== 'object') c.env = {};
  c.telegram.allowedChatIds = Array.isArray(c.telegram.allowedChatIds) ? c.telegram.allowedChatIds.map(String) : [];
  if (!c.telegram.bindings || typeof c.telegram.bindings !== 'object') c.telegram.bindings = {};
  if (!c.telegram.pairingCode) c.telegram.pairingCode = crypto.randomBytes(4).toString('hex');
  return c;
}

function normalize(raw) {
  const c = Object.assign({}, DEFAULTS, raw || {});
  c.providers = Array.isArray(c.providers) ? c.providers : [];
  c.models = Array.isArray(c.models) && c.models.length ? c.models : DEFAULTS.models.slice();
  c.control = normalizeControl(c.control);
  c.autoPing = normalizeAutoPing(c.autoPing);

  if (!c.defaultModel || !c.models.includes(c.defaultModel)) c.defaultModel = c.models[0];
  for (const p of c.providers) {
    p.id = p.id || crypto.randomUUID();
    p.name = p.name || 'provider';
    p.group = String(p.group || p.name || 'Прочее').trim() || 'Прочее';
    p.baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
    p.apiKey = p.apiKey || '';
    if (p.enabled === undefined) p.enabled = true;
    p.status = p.status || 'unknown';
    p.statusMessage = p.statusMessage || '';
    p.cooldownUntil = p.cooldownUntil || 0;
    p.requests = p.requests || 0;
    p.failures = p.failures || 0;
    p.note = p.note || '';
    // «Липкие» статусы: exhausted / auth_error выставляются вручную или подтверждённым
    // отказом апстрима и НЕ сбрасываются автоматически. Флаг ниже помечает такой статус
    // как окончательный, чтобы никакая фоновая логика его не трогала.
    if (p.sticky === undefined) p.sticky = (p.status === 'exhausted' || p.status === 'auth_error');
    p.consecutiveFailures = p.consecutiveFailures || 0;
  }
  return c;
}

function persist(conf) {
  state.selfWriteAt = Date.now();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(conf === undefined ? cfg : conf, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// Статусы ключей меняются пачками (особенно на авто-пинге), поэтому запись
// на диск склеивается: один файл вместо двадцати за секунду.
let saveTimer = null;
let savePending = false;

function writeNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  savePending = false;
  try {
    persist(cfg);
  } catch (e) {
    log('warn', 'не удалось сохранить config.json: ' + e.message);
  }
}

function save(immediate) {
  if (immediate === true) return writeNow();
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; if (savePending) writeNow(); }, 800);
  if (saveTimer.unref) saveTimer.unref();
}

function flushSave() {
  if (savePending || saveTimer) writeNow();
}

// Ограниченный по параллельности прогон: пачка из 20 ключей больше не бьёт
// по сети и по CPU всеми запросами одновременно.
function runPool(list, limit, worker, done) {
  const n = list.length;
  if (!n) return done([]);
  const cap = Math.min(Math.max(1, limit | 0 || 4), n);
  const out = [];
  let started = 0, finished = 0, live = 0;
  const pump = () => {
    while (live < cap && started < n) {
      const item = list[started++];
      live++;
      let closed = false;
      worker(item, r => {
        if (closed) return;
        closed = true;
        out.push(r);
        live--; finished++;
        if (finished >= n) done(out);
        else setImmediate(pump);
      });
    }
  };
  pump();
}


try {
  fs.watchFile(CONFIG_PATH, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (Date.now() - state.selfWriteAt < 4000) return;
    try {
      const fresh = loadConfig();
      // Сохраняем живые статусы: перезагрузка конфига с диска не должна «оживлять»
      // помеченные ключи и не должна сбрасывать текущие счётчики.
      const byId = new Map(cfg.providers.map(p => [p.id, p]));
      for (const np of fresh.providers) {
        const old = byId.get(np.id);
        if (!old) continue;
        if (old.apiKey === np.apiKey && old.baseUrl === np.baseUrl) {
          np.status = old.status;
          np.statusMessage = old.statusMessage;
          np.cooldownUntil = old.cooldownUntil;
          np.sticky = old.sticky;
          np.consecutiveFailures = old.consecutiveFailures;
          np.requests = old.requests;
          np.failures = old.failures;
          np.lastUsed = old.lastUsed;
          np.lastLatencyMs = old.lastLatencyMs;
        }
      }
      cfg = fresh;
      log('info', 'config.json изменён извне — конфигурация перезагружена, статусы ключей сохранены');
    } catch (e) {
      log('warn', 'config.json повреждён, игнорирую: ' + e.message);
    }
  });
} catch (e) {}

function log(level, msg) {
  state.logs.push({ i: ++state.logSeq, t: new Date().toISOString(), level, msg });
  if (state.logs.length > 800) state.logs.splice(0, state.logs.length - 800);
  console.log(`[${new Date().toLocaleTimeString()}] [${level}] ${msg}`);
}

function maskKey(k) {
  if (!k) return '\u2014';
  if (k.length <= 8) return k.slice(0, 2) + '\u2026';
  return k.slice(0, 6) + '\u2026' + k.slice(-4);
}

function publicProvider(p) {
  const { apiKey, ...rest } = p;
  return Object.assign({}, rest, { keyMasked: maskKey(apiKey), hasKey: !!apiKey });
}

function remoteInfo() {
  const c = cfg.control || {};
  const t = tunnel ? tunnel.status() : null;
  return {
    enabled: c.enabled !== false,
    running: !!(panel && panel.isRunning()),
    localUrl: `http://127.0.0.1:${c.port}/`,
    loginUrl: `http://127.0.0.1:${c.port}/?t=${c.token}`,
    keysUrl: `http://127.0.0.1:${c.port}/keys?t=${c.token}`,
    publicUrl: t && t.url ? t.url + '/?t=' + c.token : '',
    publicKeysUrl: t && t.url ? t.url + '/keys?t=' + c.token : '',
    token: c.token,
    pairingCode: c.telegram ? c.telegram.pairingCode : '',
    tunnel: t,
    telegram: tgBot ? tgBot.status() : null,
    sessions: control ? control.stats() : null
  };
}

function publicState() {
  return {
    port: cfg.port,
    host: cfg.host,
    strategy: cfg.strategy,
    cooldownMs: cfg.cooldownMs,
    downCooldownMs: cfg.downCooldownMs,
    activeId: cfg.activeId,
    defaultModel: cfg.defaultModel,
    models: cfg.models,
    providers: cfg.providers.map(publicProvider),
    stats: Object.assign({}, state.stats, { uptimeMs: Date.now() - state.stats.startedAt }),
    lastSeenModel: state.lastSeenModel,
    autoPing: health ? health.status() : normalizeAutoPing(cfg.autoPing),
    remote: remoteInfo()

  };
}

function isSticky(p) {
  return p.sticky === true || p.status === 'exhausted' || p.status === 'auth_error';
}

function buildChain() {
  const now = Date.now();
  let list = cfg.providers.filter(p =>
    p.enabled !== false &&
    !isSticky(p) &&
    (!p.cooldownUntil || p.cooldownUntil <= now)
  );
  if (!list.length) return [];
  if (cfg.strategy === 'pin' && cfg.activeId) {
    const act = list.find(p => p.id === cfg.activeId);
    if (act) list = [act].concat(list.filter(p => p.id !== act.id));
  } else if (cfg.strategy === 'round_robin') {
    if (state.rr >= list.length) state.rr = 0;
    list = list.slice(state.rr).concat(list.slice(0, state.rr));
    state.rr = (state.rr + 1) % list.length;
  }
  return list;
}

function setStatus(p, status, message, cooldownMs, sticky) {
  p.status = status;
  p.statusMessage = message || '';
  p.cooldownUntil = cooldownMs ? Date.now() + cooldownMs : 0;
  p.sticky = sticky === undefined
    ? (status === 'exhausted' || status === 'auth_error')
    : !!sticky;
  log(status === 'ok' ? 'info' : 'warn', `${p.name}: ${status}${message ? ' \u2014 ' + message : ''}`);
  save();
}

function markOk(p) {
  p.consecutiveFailures = 0;
  if (p.status !== 'ok' || p.statusMessage || p.sticky || p.cooldownUntil) {
    p.status = 'ok';
    p.statusMessage = '';
    p.cooldownUntil = 0;
    p.sticky = false;
    log('info', `${p.name}: OK`);
    save();
  }
}

function classifyFailure(p, statusCode, msg) {
  const m = String(msg || '').toLowerCase();
  const billing = BILLING_HINTS.some(h => m.includes(h));
  p.consecutiveFailures = (p.consecutiveFailures || 0) + 1;

  // Окончательные отказы — ключ выбывает до ручного сброса.
  if (statusCode === 402 || (billing && statusCode !== 429)) return setStatus(p, 'exhausted', msg || 'нет средств/квоты');
  if (statusCode === 401 || statusCode === 403) return setStatus(p, 'auth_error', msg || 'ключ отклонён');
  // Временные отказы — cooldown, после него ключ возвращается в ротацию.
  if (statusCode === 429) return setStatus(p, 'rate_limited', msg || 'rate limit', cfg.cooldownMs);

  // Сеть / 5xx: даём несколько попыток, но после maxFailures подряд ключ
  // помечается окончательно, чтобы не «откисал» сам по себе каждые 30 секунд.
  const limit = Math.max(1, cfg.maxFailures | 0 || 3);
  if (!cfg.autoRetryDown && p.consecutiveFailures >= limit) {
    return setStatus(p, 'down', `${msg || 'HTTP ' + statusCode} (${p.consecutiveFailures} сбоя подряд — снят до ручного сброса)`, 0, true);
  }
  return setStatus(p, 'down', msg || ('HTTP ' + statusCode), cfg.downCooldownMs, false);
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on('data', c => {
    if (done) return;
    size += c.length;
    if (size > 64 * 1024 * 1024) {
      done = true;
      req.destroy();
      cb(new Error('тело запроса слишком большое'), null);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (!done) cb(null, Buffer.concat(chunks));
  });
  req.on('error', e => {
    if (!done) cb(e, null);
  });
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    readBody(req, (err, buf) => {
      if (err) return reject(err);
      if (!buf || !buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch (e) {
        reject(new Error('невалидный JSON в теле запроса'));
      }
    });
  });
}

function readRes(res, cap, cb) {
  const chunks = [];
  let size = 0;
  res.on('data', c => {
    size += c.length;
    if (size <= cap) chunks.push(c);
  });
  res.on('end', () => cb(Buffer.concat(chunks)));
  res.on('error', () => cb(Buffer.concat(chunks)));
}

function firstLine(buf) {
  const s = buf.toString('utf8').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 200) : '';
}

function extractApiError(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  function errText(e) {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') return e.message || e.msg || JSON.stringify(e).slice(0, 300);
    return String(e);
  }
  if (j.type === 'error' && j.error) return errText(j.error);
  if (j.error) return errText(j.error);
  if (j.success === false && typeof j.message === 'string') return j.message;
  return null;
}

function respondJson(res, code, obj) {
  if (res.headersSent) {
    try { res.end(); } catch (e) {}
    return;
  }
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function sendUpstreamHeaders(res, cres, st) {
  const h = {};
  for (const [k, v] of Object.entries(cres.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
    h[k] = v;
  }
  res.writeHead(st, h);
}

function forwardOnce(p, req, res, body, cb, retries) {
  let target;
  try {
    target = new URL(p.baseUrl);
  } catch (e) {
    cb({ fatal: true, status: 0, msg: 'неверный baseUrl у провайдера ' + p.name });
    return;
  }
  const mod = target.protocol === 'https:' ? https : http;

  const drop = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'expect', 'x-api-key', 'authorization', 'accept-encoding']);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (drop.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['host'] = target.host;
  headers['content-length'] = Buffer.byteLength(body);
  if (p.apiKey) headers['x-api-key'] = p.apiKey;
  if (req.headers['authorization'] && p.apiKey) headers['authorization'] = 'Bearer ' + p.apiKey;

  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: target.pathname.replace(/\/+$/, '') + req.url,
    agent: agentFor(target.protocol),
    headers
  };

  let committed = false;
  const started = Date.now();
  const creq = mod.request(opts, cres => {
    const st = cres.statusCode || 502;
    const ct = String(cres.headers['content-type'] || '').toLowerCase();

    if (RETRY_STATUS.has(st)) {
      readRes(cres, 1024 * 1024, buf => {
        const msg = extractApiError(buf.toString('utf8')) || firstLine(buf) || ('HTTP ' + st);
        // 529 / «upstream error: do request failed» — повторяем тот же запрос
        // этому же провайдеру сразу, без переключения на следующий.
        if (isImmediateRetryable(st, msg) && (retries || 0) < MAX_IMMEDIATE_RETRIES) {
          log('warn', `${p.name}: немедленный повтор (${retries + 1}/${MAX_IMMEDIATE_RETRIES}) по ошибке ${st} — ${msg}`);
          return forwardOnce(p, req, res, body, cb, (retries || 0) + 1);
        }
        classifyFailure(p, st, msg);
        cb({ status: st, msg });
      });
      return;
    }

    if (ct.includes('application/json')) {
      readRes(cres, 25 * 1024 * 1024, buf => {
        const apiErr = extractApiError(buf.toString('utf8'));
        if (apiErr) {
          classifyFailure(p, st, apiErr);
          cb({ status: st, msg: apiErr });
          return;
        }
        committed = true;
        sendUpstreamHeaders(res, cres, st);
        res.end(buf);
        p.lastUsed = Date.now();
        p.lastLatencyMs = Date.now() - started;
        markOk(p);
        cb(null);
      });
      return;
    }

    committed = true;
    sendUpstreamHeaders(res, cres, st);
    cres.pipe(res);
    p.lastUsed = Date.now();
    p.lastLatencyMs = Date.now() - started;
    markOk(p);
    cb(null);
  });

  creq.setTimeout(15 * 60 * 1000, () => creq.destroy(new Error('таймаут ответа от апстрима')));
  creq.on('error', e => {
    if (committed) {
      try { res.destroy(); } catch (err) {}
      return;
    }
    classifyFailure(p, 0, e.message);
    cb({ status: 0, msg: e.message });
  });
  req.on('aborted', () => {
    try { creq.destroy(); } catch (err) {}
  });
  if (body.length) creq.write(body);
  creq.end();
}

function remapModel(requested) {
  if (typeof requested === 'string' && cfg.models.includes(requested)) return requested;
  return cfg.defaultModel;
}

function handleProxy(req, res) {
  readBody(req, (err, body) => {
    if (err) {
      return respondJson(res, 413, { type: 'error', error: { type: 'request_too_large', message: '[aggregator] ' + err.message } });
    }
    // Claude Code compatibility: rewrite unsupported models to a supported one
    if (req.method === 'POST' && body.length && body.length < 8 * 1024 * 1024) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (j && typeof j.model === 'string') {
          const mapped = remapModel(j.model);
          if (mapped !== j.model) {
            log('info', `модель ${j.model} -> ${mapped} (Claude Code compat)`);
            j.model = mapped;
            body = Buffer.from(JSON.stringify(j));
          }
          state.lastSeenModel = j.model;
        }
      } catch (e) {}
    }
    const chain = buildChain();
    if (!chain.length) {
      return respondJson(res, 502, {
        type: 'error',
        error: { type: 'api_error', message: '[aggregator] нет доступных провайдеров (список пуст, все выключены или в cooldown)' }
      });
    }
    state.stats.requests++;
    tryNext(chain.slice(), req, res, body, []);
  });
}

function tryNext(chain, req, res, body, attempts) {
  const p = chain.shift();
  if (!p) {
    const detail = attempts.map(a => `${a.name}: ${a.msg}`).join(' | ');
    log('error', 'все провайдеры недоступны \u2014 ' + detail);
    return respondJson(res, 502, {
      type: 'error',
      error: { type: 'api_error', message: '[aggregator] все провайдеры недоступны. ' + detail }
    });
  }
  log('info', `-> ${p.name} ${req.method} ${req.url}`);
  p.requests++;
  forwardOnce(p, req, res, body, outcome => {
    if (outcome === null) {
      // успех: делаем сработавший провайдер активным (авто-свап)
      if (cfg.activeId !== p.id) {
        cfg.activeId = p.id;
        save();
        log('info', `активный провайдер переключён на ${p.name} (авто-свап после сбоя предыдущих)`);
      }
      return;
    }
    p.failures++;
    state.stats.failovers++;
    attempts.push({ name: p.name, msg: outcome.msg || ('HTTP ' + outcome.status) });
    log('warn', `<- ${p.name} ошибка (${outcome.status || 'net'}) \u2014 переключаюсь на следующий`);
    if (!res.headersSent) {
      tryNext(chain, req, res, body, attempts);
    } else {
      try { res.destroy(); } catch (e) {}
    }
  });
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return '';
  }
}

function testProvider(p, cb) {
  let target;
  let fired = false;
  const once = r => { if (fired) return; fired = true; cb(r); };
  try {
    target = new URL(p.baseUrl);
  } catch (e) {
    once({ ok: false, info: 'неверный baseUrl' });
    return;
  }
  const mod = target.protocol === 'https:' ? https : http;
  const model = cfg.defaultModel || state.lastSeenModel || 'claude-opus-4-8';
  const payload = Buffer.from(JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }));
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: 'POST',
    path: target.pathname.replace(/\/+$/, '') + '/v1/messages',
    agent: agentFor(target.protocol),
    headers: {
      'content-type': 'application/json',
      'content-length': payload.length,
      'anthropic-version': '2023-06-01',
      'x-api-key': p.apiKey || ''
    }
  };
  const started = Date.now();
  const creq = mod.request(opts, cres => {
    const st = cres.statusCode || 0;
    readRes(cres, 1024 * 1024, buf => {
      const text = buf.toString('utf8');
      const apiErr = extractApiError(text);
      let verdict;
      if (st >= 200 && st < 300 && !apiErr) {
        verdict = { ok: true, info: 'OK, ключ живой (' + (Date.now() - started) + ' мс)' };
      } else if (st === 400) {
        verdict = { ok: true, info: 'провайдер отвечает, но модель "' + model + '" не принята \u2014 скорее всего ключ рабочий' };
      } else {
        verdict = { ok: false, info: apiErr || firstLine(buf) || ('HTTP ' + st) };
      }
      if (verdict.ok) { p.lastLatencyMs = Date.now() - started; markOk(p); }
      else classifyFailure(p, st, verdict.info);
      once(Object.assign({ status: st }, verdict));
    });
  });
  creq.setTimeout(25000, () => creq.destroy(new Error('таймаут')));
  creq.on('error', e => {
    classifyFailure(p, 0, e.message);
    once({ ok: false, info: e.message });
  });
  creq.write(payload);
  creq.end();
}

// Правка настроек авто-пинга из любой панели: принимаем только известные поля.
function applyAutoPing(patch) {
  const a = normalizeAutoPing(cfg.autoPing);
  const src = patch || {};
  if (typeof src.enabled === 'boolean') a.enabled = src.enabled;
  if (Number.isFinite(src.intervalMs)) a.intervalMs = src.intervalMs | 0;
  if (Number.isFinite(src.intervalMin)) a.intervalMs = Math.round(src.intervalMin * 60000);
  if (Number.isFinite(src.concurrency)) a.concurrency = src.concurrency | 0;
  if (typeof src.scope === 'string') a.scope = src.scope;
  if (typeof src.includeSticky === 'boolean') a.includeSticky = src.includeSticky;
  if (typeof src.includeDisabled === 'boolean') a.includeDisabled = src.includeDisabled;
  if (typeof src.notifyTelegram === 'boolean') a.notifyTelegram = src.notifyTelegram;
  cfg.autoPing = normalizeAutoPing(a);
  if (health) health.reschedule();
  log('info', `авто-пинг: ${cfg.autoPing.enabled ? 'вкл' : 'выкл'}, каждые ${Math.round(cfg.autoPing.intervalMs / 60000)} мин, охват — ${cfg.autoPing.scope === 'all' ? 'все' : 'проблемные'}`);
  return cfg.autoPing;
}

// Снять со всех ключей «мёртвые» отметки и вернуть их в ротацию.
function resetAllStatuses() {
  let n = 0;
  for (const p of cfg.providers) {
    if (p.status === 'ok' && !p.sticky && !p.cooldownUntil) continue;
    p.status = 'unknown';
    p.statusMessage = '';
    p.cooldownUntil = 0;
    p.sticky = false;
    p.consecutiveFailures = 0;
    n++;
  }
  save();
  log('info', `сброшены статусы ключей: ${n}`);
  return { ok: true, reset: n };
}

async function handleAdmin(req, res, pathname, query) {
  const send = (code, obj) => respondJson(res, code, obj);

  if (req.method === 'GET' && pathname === '/api/state') return send(200, publicState());

  if (req.method === 'GET' && pathname === '/api/logs') {
    const since = parseInt(query.get('since') || '0', 10) || 0;
    return send(200, { logs: state.logs.filter(l => l.i > since).slice(-300), cursor: state.logSeq });
  }

  let body;
  try {
    body = await readBodyJson(req);
  } catch (e) {
    return send(400, { error: e.message });
  }

  if (req.method === 'POST' && pathname === '/api/providers') {
    const name = String(body.name || '').trim();
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(body.apiKey || '').trim();
    const group = String(body.group || '').trim();
    if (!baseUrl || !apiKey) return send(400, { error: 'нужны baseUrl и apiKey' });
    const p = {
      id: crypto.randomUUID(),
      name: name || hostOf(baseUrl) || 'provider',
      group: group || name || hostOf(baseUrl) || 'Прочее',
      baseUrl,
      apiKey,
      enabled: true,
      status: 'unknown',
      statusMessage: '',
      cooldownUntil: 0,
      requests: 0,
      failures: 0,
      note: String(body.note || '').trim()
    };
    cfg.providers.push(p);
    if (!cfg.activeId) cfg.activeId = p.id;
    save();
    log('info', 'добавлен провайдер: ' + p.name + ' (' + p.baseUrl + ') [' + p.group + ']');
    return send(201, publicProvider(p));
  }

  if (req.method === 'POST' && pathname === '/api/providers/bulk') {
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    const group = String(body.group || '').trim();
    const namePrefix = String(body.namePrefix || group || hostOf(baseUrl) || 'key').trim();
    const raw = String(body.keys || '');
    if (!baseUrl) return send(400, { error: 'нужен baseUrl' });
    const keys = raw.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    const uniq = Array.from(new Set(keys));
    if (!uniq.length) return send(400, { error: 'не найдено ни одного ключа' });
    let added = 0;
    uniq.forEach((k, idx) => {
      const p = {
        id: crypto.randomUUID(),
        name: namePrefix + '-' + (idx + 1),
        group: group || namePrefix || 'Прочее',
        baseUrl,
        apiKey: k,
        enabled: true,
        status: 'unknown',
        statusMessage: '',
        cooldownUntil: 0,
        requests: 0,
        failures: 0,
        note: ''
      };
      cfg.providers.push(p);
      if (!cfg.activeId) cfg.activeId = p.id;
      added++;
    });
    save();
    log('info', `bulk-добавление: ${added} ключей в группу "${group || namePrefix}"`);
    return send(201, { added, total: cfg.providers.length });
  }

  if (req.method === 'POST' && pathname === '/api/stats/reset') {
    state.stats = { requests: 0, failovers: 0, startedAt: Date.now() };
    cfg.providers.forEach(p => { p.requests = 0; p.failures = 0; });
    save();
    log('info', 'статистика сброшена');
    return send(200, publicState());
  }

  if (req.method === 'GET' && pathname === '/api/export') {
    const dump = {
      strategy: cfg.strategy,
      defaultModel: cfg.defaultModel,
      models: cfg.models,
      providers: cfg.providers.map(p => ({ name: p.name, group: p.group, baseUrl: p.baseUrl, apiKey: p.apiKey, enabled: p.enabled, note: p.note }))
    };
    return send(200, dump);
  }

  if (req.method === 'POST' && /^\/api\/groups\/[^/]+\/(test|enable|disable|reset|activate)$/.test(pathname)) {
    const parts = pathname.split('/');
    const groupName = decodeURIComponent(parts[3]);
    const action = parts[4];
    const list = cfg.providers.filter(p => p.group === groupName);
    if (!list.length) return send(404, { error: 'группа не найдена' });

    if (action === 'enable' || action === 'disable') {
      list.forEach(p => { p.enabled = action === 'enable'; });
      save();
      log('info', `группа "${groupName}": ${action === 'enable' ? 'включена' : 'выключена'} (${list.length})`);
      return send(200, publicState());
    }
    if (action === 'reset') {
      list.forEach(p => { p.status = 'unknown'; p.statusMessage = ''; p.cooldownUntil = 0; p.sticky = false; p.consecutiveFailures = 0; });
      save();
      log('info', `группа "${groupName}": статусы сброшены`);
      return send(200, publicState());
    }
    if (action === 'activate') {
      const cand = list.find(p => p.enabled !== false && !isSticky(p)) || list[0];
      cfg.activeId = cand.id;
      cand.enabled = true;
      cand.cooldownUntil = 0;
      cand.sticky = false;
      cand.consecutiveFailures = 0;
      save();
      log('info', `группа "${groupName}": активирован ${cand.name}`);
      return send(200, publicState());
    }
    if (action === 'test') {
      log('info', `тест группы "${groupName}": ${list.length} шт.`);
      return runPool(list, (cfg.autoPing && cfg.autoPing.concurrency) || 4,
        (p, done) => testProvider(p, r => done({ id: p.id, name: p.name, ok: r.ok, info: r.info, status: r.status })),
        results => send(200, { results }));
    }

  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    if (['priority', 'round_robin', 'pin'].includes(body.strategy)) cfg.strategy = body.strategy;
    if (Number.isFinite(body.cooldownMs)) cfg.cooldownMs = Math.max(5000, body.cooldownMs | 0);
    if (Number.isFinite(body.downCooldownMs)) cfg.downCooldownMs = Math.max(5000, body.downCooldownMs | 0);
    if (Array.isArray(body.models)) {
      const clean = body.models.map(x => String(x || '').trim()).filter(Boolean);
      if (clean.length) cfg.models = Array.from(new Set(clean));
    }
    if (typeof body.defaultModel === 'string' && cfg.models.includes(body.defaultModel)) {
      cfg.defaultModel = body.defaultModel;
    } else if (!cfg.models.includes(cfg.defaultModel)) {
      cfg.defaultModel = cfg.models[0];
    }
    if (body.autoPing && typeof body.autoPing === 'object') applyAutoPing(body.autoPing);
    save();
    log('info', 'настройки обновлены: strategy=' + cfg.strategy + ', defaultModel=' + cfg.defaultModel);
    return send(200, publicState());
  }

  if (req.method === 'POST' && pathname === '/api/autoping') {
    applyAutoPing(body);
    save();
    return send(200, publicState());
  }

  if (req.method === 'POST' && pathname === '/api/ping-now') {
    if (!health) return send(400, { error: 'авто-пинг недоступен' });
    return health.runNow(r => send(200, { autoPing: health.status(), run: r }));
  }

  if (req.method === 'POST' && pathname === '/api/providers/reset-all') {
    const r = resetAllStatuses();
    return send(200, Object.assign({ state: publicState() }, r));
  }

  if (req.method === 'POST' && pathname === '/api/test-all') {
    const list = cfg.providers.slice();
    if (!list.length) return send(200, { results: [] });
    log('info', 'тест всех ключей: ' + list.length + ' шт.');
    return runPool(list, (cfg.autoPing && cfg.autoPing.concurrency) || 4,
      (p, done) => testProvider(p, r => done({ id: p.id, name: p.name, ok: r.ok, info: r.info, status: r.status })),
      results => {
        const okc = results.filter(x => x.ok).length;
        log('info', `тест всех завершён: ${okc}/${list.length} рабочих`);
        send(200, { results });
      });
  }


  const m = pathname.match(/^\/api\/providers\/([\w-]+)(?:\/(activate|test|reset|move))?$/);
  if (m) {
    const p = cfg.providers.find(x => x.id === m[1]);
    if (!p) return send(404, { error: 'провайдер не найден' });
    const action = m[2];

    if (req.method === 'PATCH' && !action) {
      if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
      if (typeof body.group === 'string' && body.group.trim()) p.group = body.group.trim();
      if (typeof body.note === 'string') p.note = body.note.trim();
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) p.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        p.apiKey = body.apiKey.trim();
        p.status = 'unknown';
        p.statusMessage = '';
        p.cooldownUntil = 0;
        p.sticky = false;
        p.consecutiveFailures = 0;
      }
      if (typeof body.enabled === 'boolean') p.enabled = body.enabled;
      save();
      return send(200, publicProvider(p));
    }

    if (req.method === 'DELETE' && !action) {
      cfg.providers = cfg.providers.filter(x => x.id !== p.id);
      if (cfg.activeId === p.id) cfg.activeId = cfg.providers.length ? cfg.providers[0].id : null;
      save();
      log('info', 'удалён провайдер: ' + p.name);
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && action === 'activate') {
      cfg.activeId = p.id;
      p.enabled = true;
      p.cooldownUntil = 0;
      p.sticky = false;
      p.consecutiveFailures = 0;
      if (p.status !== 'ok') {
        p.status = 'unknown';
        p.statusMessage = '';
      }
      save();
      log('info', 'активный провайдер: ' + p.name);
      return send(200, publicProvider(p));
    }

    if (req.method === 'POST' && action === 'reset') {
      p.status = 'unknown';
      p.statusMessage = '';
      p.cooldownUntil = 0;
      p.sticky = false;
      p.consecutiveFailures = 0;
      save();
      return send(200, publicProvider(p));
    }

    if (req.method === 'POST' && action === 'move') {
      const dir = body.dir === 'up' ? -1 : 1;
      const i = cfg.providers.indexOf(p);
      const j = i + dir;
      if (j >= 0 && j < cfg.providers.length) {
        cfg.providers[i] = cfg.providers[j];
        cfg.providers[j] = p;
        save();
      }
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && action === 'test') {
      return testProvider(p, r => send(200, r));
    }
  }

  if (req.method === 'GET' && pathname === '/api/remote') return send(200, remoteInfo());

  if (req.method === 'POST' && /^\/api\/remote\/(tunnel|telegram)\/(start|stop|restart)$/.test(pathname)) {
    const [, , , what, action] = pathname.split('/');
    if (what === 'tunnel') {
      if (!tunnel) return send(400, { error: 'туннель недоступен' });
      const target = 'http://127.0.0.1:' + cfg.control.port;
      if (action === 'start') tunnel.start(target);
      else if (action === 'stop') tunnel.stop();
      else tunnel.restart(target);
      return send(200, remoteInfo());
    }
    if (!tgBot) return send(400, { error: 'бот недоступен' });
    if (action === 'stop') tgBot.stop();
    else await tgBot.start();
    return send(200, remoteInfo());
  }

  send(404, { error: 'not found' });
}

function serveIndex(res) {
  fs.readFile(path.join(ROOT, 'public', 'index.html'), (err, buf) => {
    if (err) return respondJson(res, 500, { error: 'index.html не найден' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    return respondJson(res, 400, { error: 'bad url' });
  }
  const pathname = u.pathname;

  if (pathname.startsWith('/api/')) {
    handleAdmin(req, res, pathname, u.searchParams).catch(e => respondJson(res, 500, { error: e.message }));
    return;
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  // Claude Code compatibility: expose only the allowed models
  if (req.method === 'GET' && pathname === '/v1/models') {
    const now = new Date().toISOString();
    return respondJson(res, 200, {
      data: cfg.models.map(id => ({ id, type: 'model', display_name: id, created_at: now })),
      first_id: cfg.models[0] || null,
      last_id: cfg.models[cfg.models.length - 1] || null,
      has_more: false
    });
  }
  handleProxy(req, res);
});

server.on('error', e => {
  console.error('[fatal] не удалось запустить сервер: ' + e.message);
  if (e.code === 'EADDRINUSE') console.error('[fatal] порт ' + cfg.port + ' занят \u2014 возможно, агрегатор уже запущен');
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log('info', `агрегатор запущен: http://${cfg.host}:${cfg.port}`);
  log('info', `админка: http://${cfg.host}:${cfg.port}/`);
  log('info', 'провайдеров в конфиге: ' + cfg.providers.length);
  startHealth();
  startRemote();
});

// ─────────────── авто-пинг ключей ───────────────

function startHealth() {
  health = createHealthcheck({
    getCfg: () => cfg,
    log,
    testProvider,
    notify: text => { try { if (tgBot && tgBot.broadcast) tgBot.broadcast(text); } catch (e) {} },
    onDone: () => {
      flushSave();
      try { if (panel) panel.broadcast({ t: 'agg', aggregator: aggAdapter().summary() }); } catch (e) {}
    }
  });
  health.start();
}


// ─────────────── удалённое управление Claude Code ───────────────

function aggAdapter() {
  return {
    summary() {
      const now = Date.now();
      const list = cfg.providers.map(p => ({
        id: p.id,
        name: p.name,
        group: p.group,
        status: p.status,
        statusMessage: p.statusMessage,
        enabled: p.enabled !== false,
        active: cfg.activeId === p.id,
        sticky: isSticky(p),
        latency: p.lastLatencyMs || 0,
        cooldownLeft: p.cooldownUntil && p.cooldownUntil > now ? p.cooldownUntil - now : 0,
        requests: p.requests,
        failures: p.failures
      }));
      const active = cfg.providers.find(p => p.id === cfg.activeId);
      return {
        total: list.length,
        ok: list.filter(p => p.status === 'ok').length,
        active: active ? active.name : '',
        strategy: cfg.strategy,
        defaultModel: cfg.defaultModel,
        models: cfg.models,
        requests: state.stats.requests,
        failovers: state.stats.failovers,
        autoPing: health ? health.status() : normalizeAutoPing(cfg.autoPing),
        providers: list
      };
    },
    activate(id) {
      const p = cfg.providers.find(x => x.id === id);
      if (!p) return { ok: false, error: 'ключ не найден' };
      cfg.activeId = p.id;
      p.enabled = true;
      p.cooldownUntil = 0;
      p.sticky = false;
      p.consecutiveFailures = 0;
      if (p.status !== 'ok') { p.status = 'unknown'; p.statusMessage = ''; }
      save();
      log('info', 'панель: активный ключ — ' + p.name);
      return { ok: true, name: p.name };
    },
    testOne(id, cb) {
      const p = cfg.providers.find(x => x.id === id);
      if (!p) return cb({ ok: false, error: 'ключ не найден' });
      return testProvider(p, r => cb(Object.assign({ id: p.id, name: p.name }, r)));
    },
    resetAll() {
      return resetAllStatuses();
    },
    autoPing() {
      return health ? health.status() : normalizeAutoPing(cfg.autoPing);
    },
    setAutoPing(patch) {
      applyAutoPing(patch);
      save();
      return health ? health.status() : normalizeAutoPing(cfg.autoPing);
    },
    pingNow(cb) {
      if (!health) return cb({ error: 'авто-пинг недоступен' });
      return health.runNow(r => cb(r));
    },
    testAll(cb) {
      const list = cfg.providers.slice();
      if (!list.length) return cb({ results: [] });
      return runPool(list, (cfg.autoPing && cfg.autoPing.concurrency) || 4,
        (p, done) => testProvider(p, r => done({ id: p.id, name: p.name, ok: r.ok, info: r.info })),
        results => cb({ results }));
    }
  };
}

function startRemote() {
  const c = cfg.control || {};
  if (c.enabled === false) {
    log('info', 'удалённое управление выключено (control.enabled = false)');
    return;
  }
  const getCfg = () => cfg;

  control = createControl({ root: ROOT, getCfg, log });
  tunnel = createTunnel({ getCfg, log });
  tgBot = createTelegramBot({
    getCfg,
    save,
    log,
    control,
    agg: aggAdapter(),
    getLinks: () => {
      const t = tunnel.status();
      return {
        tunnelUrl: t.url ? t.url + '/?t=' + cfg.control.token : '',
        keysUrl: t.url ? t.url + '/keys?t=' + cfg.control.token : '',
        localUrl: `http://127.0.0.1:${cfg.control.port}/?t=${cfg.control.token}`,
        localKeysUrl: `http://127.0.0.1:${cfg.control.port}/keys?t=${cfg.control.token}`,
        token: cfg.control.token,
        aggregator: aggAdapter().summary()
      };
    }
  });
  panel = createWebPanel({
    root: ROOT,
    getCfg,
    save,
    log,
    control,
    telegram: tgBot,
    tunnel,
    agg: aggAdapter(),
    // Админка ключей публикуется наружу только через панель, под её токеном.
    adminApi: (req, res, pathname, query) => handleAdmin(req, res, pathname, query)
  });
  panel.start();

  // Быстрый туннель выдаёт новый адрес при каждом перезапуске — сообщаем в чат,
  // иначе снаружи не попасть в панель.
  let lastTunnelUrl = '';
  tunnel.onEvent(s => {
    if (!s.url || s.url === lastTunnelUrl) return;
    lastTunnelUrl = s.url;
    if (!tgBot || !tgBot.broadcast) return;
    tgBot.broadcast('🌍 Новый внешний адрес панели:\n' + s.url + '/?t=' + cfg.control.token +
      '\nключи: ' + s.url + '/keys?t=' + cfg.control.token);
  });


  if (c.telegram && c.telegram.enabled && String(c.telegram.botToken || '').trim()) {
    tgBot.start().catch(e => log('warn', 'telegram: ' + e.message));
  } else {
    log('info', 'telegram-бот выключен — впиши токен в панели и включи');
  }

  if (c.cloudflare && c.cloudflare.enabled && c.cloudflare.autoStart !== false) {
    tunnel.start('http://127.0.0.1:' + c.port);
  } else {
    log('info', 'cloudflare-туннель выключен — включается в панели');
  }
}

function shutdown() {
  log('info', 'останов...');
  try { if (health) health.stop(); } catch (e) {}
  try { if (control) control.shutdown(); } catch (e) {}
  try { if (tunnel) tunnel.stop(); } catch (e) {}
  try { if (tgBot) tgBot.stop(); } catch (e) {}
  try { if (panel) panel.stop(); } catch (e) {}
  try { flushSave(); } catch (e) {}
  setTimeout(() => process.exit(0), 400);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { flushSave(); } catch (e) {} });

// Одиночный сбой в фоновой задаче не должен ронять прокси целиком.
process.on('unhandledRejection', e => log('warn', 'необработанный сбой: ' + (e && e.message ? e.message : e)));
process.on('uncaughtException', e => {
  log('error', 'непойманное исключение: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  try { flushSave(); } catch (err) {}
});


