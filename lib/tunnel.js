'use strict';

// Публикация локальной панели наружу через Cloudflare Tunnel.
// Два режима:
//   quick — бесплатный *.trycloudflare.com, ничего настраивать не нужно;
//   token — именованный туннель (свой домен), запускается по токену из дашборда Cloudflare.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

function resolveBin(want) {
  const cands = [];
  if (want && want !== 'cloudflared') cands.push(want);
  if (process.platform === 'win32') {
    cands.push('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
    cands.push('C:\\Program Files\\cloudflared\\cloudflared.exe');
    cands.push(path.join(process.env.USERPROFILE || '', '.local', 'bin', 'cloudflared.exe'));
  } else {
    cands.push('/usr/local/bin/cloudflared');
    cands.push('/usr/bin/cloudflared');
    cands.push('/opt/homebrew/bin/cloudflared');
  }
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return want || 'cloudflared';
}

function createTunnel({ getCfg, log }) {
  const st = {
    proc: null,
    url: '',
    mode: 'quick',
    startedAt: 0,
    lastError: '',
    lines: [],
    restarts: 0,
    stopping: false,
    retryTimer: null
  };
  const listeners = new Set();

  const conf = () => (getCfg().control && getCfg().control.cloudflare) || {};
  const onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const emitNow = () => {
    st.emitTimer = null;
    st.emitAt = Date.now();
    for (const fn of listeners) { try { fn(status()); } catch (e) {} }
  };
  // cloudflared сыпет строками на каждое соединение. Раздавать на каждую строку
  // полный снимок состояния в SSE — лишняя нагрузка, поэтому склеиваем.
  const emit = () => {
    if (st.emitTimer) return;
    const wait = Math.max(0, 1500 - (Date.now() - (st.emitAt || 0)));
    if (!wait) return emitNow();
    st.emitTimer = setTimeout(emitNow, wait);
    if (st.emitTimer.unref) st.emitTimer.unref();
  };

  function addLine(s) {
    const t = String(s || '').trim();
    if (!t) return;
    st.lines.push(t.slice(0, 400));
    if (st.lines.length > 60) st.lines.splice(0, st.lines.length - 60);
  }

  function status() {
    const c = conf();
    return {
      running: !!st.proc,
      url: st.url || (c.mode === 'token' && c.hostname ? 'https://' + String(c.hostname).replace(/^https?:\/\//, '') : ''),
      mode: c.mode || 'quick',
      enabled: c.enabled !== false,
      bin: resolveBin(c.cloudflaredPath),
      pid: st.proc ? st.proc.pid : 0,
      startedAt: st.startedAt,
      restarts: st.restarts,
      lastError: st.lastError,
      log: st.lines.slice(-25)
    };
  }

  function killTree(proc) {
    if (!proc) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        // Если taskkill почему-то не сработал — добиваем через сигнал.
        const t = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 4000);
        if (t.unref) t.unref();
        return;
      } catch (e) {}
    }
    try { proc.kill('SIGTERM'); } catch (e) {}
  }

  function stop() {
    st.stopping = true;
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
    if (st.proc) {
      killTree(st.proc);
      log('info', 'cloudflare: туннель остановлен');
    }
    st.proc = null;
    st.url = '';
    emitNow();
    return status();
  }

  function start(target) {
    const c = conf();
    if (st.proc) return status();
    st.stopping = false;
    const bin = resolveBin(c.cloudflaredPath);
    const mode = c.mode === 'token' ? 'token' : 'quick';
    const url = target || ('http://127.0.0.1:' + ((getCfg().control && getCfg().control.port) || 8788));
    const args = ['--no-autoupdate', 'tunnel'];
    if (mode === 'token') {
      if (!String(c.tunnelToken || '').trim()) {
        st.lastError = 'не задан tunnelToken для именованного туннеля';
        emit();
        return status();
      }
      args.push('run', '--token', String(c.tunnelToken).trim());
    } else {
      args.push('--url', url);
    }
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      st.lastError = e.message;
      log('warn', 'cloudflare: не удалось запустить cloudflared — ' + e.message);
      emit();
      return status();
    }
    st.proc = proc;
    st.mode = mode;
    st.startedAt = Date.now();
    st.lastError = '';
    st.url = '';
    log('info', `cloudflare: запуск туннеля (${mode}) -> ${mode === 'quick' ? url : (c.hostname || 'named')}`);

    const onData = d => {
      const text = d.toString('utf8');
      for (const line of text.split('\n')) {
        addLine(line);
        const m = line.match(URL_RE);
        if (m && st.url !== m[0]) {
          st.url = m[0];
          st.restarts = 0;
          log('info', 'cloudflare: публичный адрес — ' + st.url);
          emitNow();
        }
        if (/ERR|error=/i.test(line) && !st.url) st.lastError = line.trim().slice(0, 300);
      }
      emit();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', e => {
      if (st.proc !== proc) return;
      st.lastError = e.message;
      log('warn', 'cloudflare: ошибка процесса — ' + e.message);
    });
    proc.on('close', code => {
      // Старый процесс может умереть уже после того, как поднялся новый
      // (перезапуск, taskkill с задержкой) — тогда его close нас не касается.
      if (st.proc !== proc) return;
      st.proc = null;
      const wasUrl = st.url;
      st.url = '';
      emitNow();
      if (st.stopping) return;
      log('warn', `cloudflare: cloudflared завершился (код ${code})${wasUrl ? ', адрес сброшен' : ''}`);
      if (conf().autoRestart !== false) {
        st.restarts++;
        const delay = Math.min(60000, 3000 * Math.min(10, st.restarts));
        st.retryTimer = setTimeout(() => {
          st.retryTimer = null;
          if (!st.stopping) start(target);
        }, delay);
        if (st.retryTimer.unref) st.retryTimer.unref();
        log('info', `cloudflare: перезапуск через ${Math.round(delay / 1000)} с`);
      }
    });
    emitNow();
    return status();
  }

  function restart(target) {
    stop();
    // Пауза, чтобы старый cloudflared успел отпустить порт и соединения.
    st.restarts = 0;
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null;
      st.stopping = false;
      start(target);
    }, 1500);
    if (st.retryTimer.unref) st.retryTimer.unref();
    return status();
  }

  return { start, stop, restart, status, onEvent, resolveBin: () => resolveBin(conf().cloudflaredPath) };
}

module.exports = { createTunnel };
