'use strict';

// Прокси для запросов к Telegram: в некоторых сетях api.telegram.org недоступен
// напрямую. Поддержаны http/https (метод CONNECT) и socks5/socks5h.
// Без внешних зависимостей: свой Agent, который сам открывает туннель.

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');

function parse(url) {
  const u = new URL(String(url));
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks', 'socks5', 'socks5h'].includes(scheme)) {
    throw new Error('неизвестный тип прокси: ' + scheme);
  }
  return {
    scheme,
    host: u.hostname,
    port: Number(u.port) || (scheme === 'https' ? 443 : scheme === 'http' ? 8080 : 1080),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : ''
  };
}

// CONNECT host:port через обычный http-прокси.
function connectHttp(p, host, port, cb) {
  const headers = { host: host + ':' + port };
  if (p.user || p.pass) {
    headers['proxy-authorization'] = 'Basic ' + Buffer.from(p.user + ':' + p.pass).toString('base64');
  }
  const mod = p.scheme === 'https' ? https : http;
  const req = mod.request({
    host: p.host, port: p.port, method: 'CONNECT',
    path: host + ':' + port, headers, rejectUnauthorized: false, agent: false
  });
  let done = false;
  const fail = e => { if (!done) { done = true; cb(e); } };
  req.setTimeout(20000, () => { req.destroy(new Error('прокси не ответил')); });
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return fail(new Error('прокси отклонил CONNECT (' + res.statusCode + ')'));
    }
    done = true;
    cb(null, socket);
  });
  req.once('error', fail);
  req.end();
}

// Рукопожатие socks5: выбор метода, при необходимости логин/пароль, затем CONNECT.
function connectSocks(p, host, port, cb) {
  const sock = net.connect(p.port, p.host);
  let done = false;
  const fail = e => { if (!done) { done = true; try { sock.destroy(); } catch (x) {} cb(e); } };
  sock.setTimeout(20000, () => fail(new Error('socks-прокси не ответил')));
  sock.once('error', fail);

  let stage = 'greet';
  let buf = Buffer.alloc(0);

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'greet') {
      if (buf.length < 2) return;
      if (buf[0] !== 5) return fail(new Error('это не socks5'));
      const method = buf[1];
      buf = buf.slice(2);
      if (method === 0) { stage = 'connect'; return request(); }
      if (method === 2) {
        if (!p.user) return fail(new Error('socks-прокси требует логин и пароль'));
        stage = 'auth';
        const u = Buffer.from(p.user), w = Buffer.from(p.pass);
        return sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
      }
      return fail(new Error('socks5: метод авторизации не поддержан'));
    }
    if (stage === 'auth') {
      if (buf.length < 2) return;
      if (buf[1] !== 0) return fail(new Error('socks5: логин или пароль не подошли'));
      buf = buf.slice(2);
      stage = 'connect';
      return request();
    }
    if (stage === 'connect') {
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail(new Error('socks5: соединение отклонено (код ' + buf[1] + ')'));
      const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
      if (buf.length < need) return;
      buf = buf.slice(need);
      stage = 'ready';
      done = true;
      sock.setTimeout(0);
      sock.removeAllListeners('data');
      sock.removeAllListeners('error');
      if (buf.length) sock.unshift(buf);
      return cb(null, sock);
    }
  });

  function request() {
    const h = Buffer.from(host);
    sock.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])
    ]));
  }

  sock.once('connect', () => sock.write(Buffer.from(p.user ? [5, 2, 0, 2] : [5, 1, 0])));
}

// Agent для https: сначала туннель через прокси, потом TLS поверх него.
class ProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.p = parse(proxyUrl);
    this.url = String(proxyUrl);
  }
  createConnection(options, cb) {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    const wrap = (err, socket) => {
      if (err) return cb(err);
      const secure = tls.connect({ socket, servername: host });
      secure.once('error', e => cb(e));
      secure.once('secureConnect', () => cb(null, secure));
    };
    if (this.p.scheme === 'http' || this.p.scheme === 'https') return connectHttp(this.p, host, port, wrap);
    return connectSocks(this.p, host, port, wrap);
  }
}

const cache = new Map();

// Вернуть agent для указанного прокси (или null, если прокси не задан).
// Агенты кешируются по адресу, чтобы не пересоздавать на каждый запрос.
function agentFor(proxyUrl) {
  const key = String(proxyUrl || '').trim();
  if (!key) return null;
  if (!cache.has(key)) cache.set(key, new ProxyAgent(key));
  return cache.get(key);
}

// Проверить строку прокси, не открывая соединения. Бросает при ошибке.
function checkProxy(proxyUrl) {
  const p = parse(proxyUrl);
  return p.scheme + '://' + p.host + ':' + p.port;
}

module.exports = { agentFor, checkProxy };
