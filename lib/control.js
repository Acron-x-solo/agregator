'use strict';

// Пульт Claude Code: запускает CLI в режиме `-p --output-format stream-json`,
// разбирает поток событий, ведёт историю сессий и раздаёт события подписчикам
// (веб-панель через SSE, Telegram-бот через сообщения).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_MESSAGES = 400;
const MAX_TEXT = 12000;
// Ровно те значения, которые принимает `claude --permission-mode` (2.1.x).
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

function resolveBin(want) {
  const cands = [];
  if (want && want !== 'claude') cands.push(want);
  const home = os.homedir();
  if (process.platform === 'win32') {
    cands.push(path.join(home, '.local', 'bin', 'claude.exe'));
    cands.push(path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'));
    cands.push(path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'));
  } else {
    cands.push(path.join(home, '.local', 'bin', 'claude'));
    cands.push('/usr/local/bin/claude');
    cands.push('/opt/homebrew/bin/claude');
  }
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return want || 'claude';
}

// spawn(shell:true) на Windows не экранирует аргументы — делаем это сами.
function quoteArg(a) {
  const s = String(a);
  return /[\s"^&|<>()]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '… [обрезано]' : t;
}

function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return clip(i.command || '', 400);
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return clip(i.file_path || i.notebook_path || '', 300);
  if (name === 'Glob' || name === 'Grep') return clip((i.pattern || '') + (i.path ? ' — ' + i.path : ''), 300);
  if (name === 'WebFetch' || name === 'WebSearch') return clip(i.url || i.query || '', 300);
  if (name === 'Task' || name === 'Agent') return clip(i.description || i.prompt || '', 300);
  if (name === 'Skill') return clip(i.skill || '', 200);
  const keys = Object.keys(i);
  if (!keys.length) return '';
  return clip(JSON.stringify(i), 300);
}
function createControl({ root, getCfg, log }) {
  const STATE_PATH = path.join(root, 'control-sessions.json');
  const sessions = new Map();
  const listeners = new Set();
  let persistTimer = null;
  let msgSeq = 0;

  const conf = () => (getCfg().control || {});

  function emit(ev) {
    for (const fn of listeners) {
      try { fn(ev); } catch (e) {}
    }
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function publicSession(s) {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      model: s.model || '',
      permissionMode: s.permissionMode,
      effort: s.effort || '',
      status: s.status,
      queued: s.queue.length,
      turns: s.turns,
      costUsd: Math.round((s.costUsd || 0) * 10000) / 10000,
      tokensIn: s.tokensIn || 0,
      tokensOut: s.tokensOut || 0,
      createdAt: s.createdAt,
      lastAt: s.lastAt,
      claudeSessionId: s.claudeSessionId || null,
      messageCount: s.messages.length,
      lastError: s.lastError || '',
      live: s.status === 'running' ? clip(s.live || '', 4000) : ''
    };
  }

  function list() {
    return Array.from(sessions.values())
      .sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt))
      .map(publicSession);
  }

  function get(id) {
    return sessions.get(String(id || ''));
  }
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const dump = Array.from(sessions.values()).map(s => ({
          id: s.id, name: s.name, cwd: s.cwd, model: s.model, permissionMode: s.permissionMode,
          effort: s.effort, createdAt: s.createdAt, lastAt: s.lastAt, turns: s.turns,
          costUsd: s.costUsd, tokensIn: s.tokensIn, tokensOut: s.tokensOut,
          claudeSessionId: s.claudeSessionId, started: s.started,
          messages: s.messages.slice(-MAX_MESSAGES).map(m => ({ ...m, text: clip(m.text, MAX_TEXT) }))
        }));
        const tmp = STATE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ sessions: dump }, null, 1));
        fs.renameSync(tmp, STATE_PATH);
      } catch (e) {
        log('warn', 'control: не удалось сохранить сессии — ' + e.message);
      }
    }, 1200);
  }

  function restore() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      return;
    }
    for (const d of (raw && Array.isArray(raw.sessions) ? raw.sessions : [])) {
      if (!d || !d.id) continue;
      sessions.set(d.id, {
        id: d.id,
        name: d.name || 'сессия',
        cwd: d.cwd || conf().defaultCwd || root,
        model: d.model || '',
        permissionMode: PERMISSION_MODES.includes(d.permissionMode) ? d.permissionMode : 'acceptEdits',
        effort: d.effort || '',
        status: 'idle',
        createdAt: d.createdAt || Date.now(),
        lastAt: d.lastAt || d.createdAt || Date.now(),
        turns: d.turns || 0,
        costUsd: d.costUsd || 0,
        tokensIn: d.tokensIn || 0,
        tokensOut: d.tokensOut || 0,
        claudeSessionId: d.claudeSessionId || null,
        started: !!d.started,
        messages: Array.isArray(d.messages) ? d.messages.slice(-MAX_MESSAGES) : [],
        queue: [],
        proc: null,
        live: '',
        stderr: '',
        lastError: ''
      });
    }
    if (sessions.size) log('info', `control: восстановлено сессий — ${sessions.size}`);
  }
  function push(s, msg) {
    const m = Object.assign({ i: ++msgSeq, at: Date.now() }, msg);
    m.text = clip(m.text || '', MAX_TEXT);
    s.messages.push(m);
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    s.lastAt = m.at;
    emit({ t: 'msg', sessionId: s.id, msg: m });
    persistSoon();
    return m;
  }

  function touch(s) {
    emit({ t: 'session', sessionId: s.id, session: publicSession(s) });
  }

  function checkDir(dir) {
    const abs = path.resolve(dir);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error('это не папка: ' + abs);
    return abs;
  }

  function createSession(opts) {
    const o = opts || {};
    const c = conf();
    const cwd = checkDir(o.cwd || c.defaultCwd || root);
    const attach = String(o.attachId || '').trim();
    const s = {
      id: attach && /^[0-9a-f-]{36}$/i.test(attach) ? attach : crypto.randomUUID(),
      name: String(o.name || '').trim() || path.basename(cwd) || 'сессия',
      cwd,
      model: String(o.model || c.defaultModel || '').trim(),
      permissionMode: PERMISSION_MODES.includes(o.permissionMode) ? o.permissionMode : (PERMISSION_MODES.includes(c.permissionMode) ? c.permissionMode : 'acceptEdits'),
      effort: EFFORTS.includes(o.effort) ? o.effort : (c.defaultEffort || ''),
      status: 'idle',
      createdAt: Date.now(),
      lastAt: Date.now(),
      turns: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      claudeSessionId: attach || null,
      started: !!attach,
      messages: [],
      queue: [],
      proc: null,
      live: '',
      stderr: '',
      lastError: ''
    };
    sessions.set(s.id, s);
    log('info', `control: новая сессия "${s.name}" в ${s.cwd}${attach ? ' (подключение к ' + attach + ')' : ''}`);
    push(s, { role: 'system', text: attach ? `подключено к сессии ${attach}` : `сессия создана: ${s.cwd}` });
    touch(s);
    return publicSession(s);
  }
  function patchSession(id, o) {
    const s = get(id);
    if (!s) throw new Error('сессия не найдена');
    if (typeof o.name === 'string' && o.name.trim()) s.name = o.name.trim();
    if (typeof o.cwd === 'string' && o.cwd.trim()) {
      if (s.proc) throw new Error('нельзя менять папку во время работы');
      s.cwd = checkDir(o.cwd);
      // Клод привязывает сессию к папке — после смены cwd начинаем новую.
      s.claudeSessionId = null;
      s.started = false;
      push(s, { role: 'system', text: 'папка изменена: ' + s.cwd + ' (контекст начат заново)' });
    }
    if (typeof o.model === 'string') s.model = o.model.trim();
    if (PERMISSION_MODES.includes(o.permissionMode)) s.permissionMode = o.permissionMode;
    if (EFFORTS.includes(o.effort)) s.effort = o.effort;
    persistSoon();
    touch(s);
    return publicSession(s);
  }

  function deleteSession(id) {
    const s = get(id);
    if (!s) return false;
    stop(id, 'сессия удалена');
    sessions.delete(s.id);
    emit({ t: 'removed', sessionId: s.id });
    log('info', 'control: сессия удалена — ' + s.name);
    persistSoon();
    return true;
  }

  function clearSession(id) {
    const s = get(id);
    if (!s) throw new Error('сессия не найдена');
    if (s.proc) throw new Error('идёт работа — сначала останови');
    s.messages = [];
    s.claudeSessionId = null;
    s.started = false;
    s.turns = 0;
    s.live = '';
    push(s, { role: 'system', text: 'контекст очищен, следующий запрос начнёт новую сессию Claude' });
    touch(s);
    return publicSession(s);
  }

  function history(id) {
    const s = get(id);
    if (!s) throw new Error('сессия не найдена');
    return { session: publicSession(s), messages: s.messages };
  }
  // Простой файловый навигатор для выбора рабочей папки с телефона.
  function browse(dir) {
    const target = dir && String(dir).trim() ? path.resolve(String(dir)) : (conf().defaultCwd || os.homedir());
    const st = fs.statSync(target);
    if (!st.isDirectory()) throw new Error('это не папка');
    const items = fs.readdirSync(target, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .slice(0, 300)
      .map(d => ({ name: d.name, path: path.join(target, d.name) }));
    const up = path.dirname(target);
    return { path: target, parent: up === target ? null : up, dirs: items };
  }

  function childEnv() {
    const env = Object.assign({}, process.env, conf().env || {});
    // Убираем метки «я запущен внутри Claude Code», иначе дочерний процесс
    // считает себя вложенным агентом.
    for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT']) {
      delete env[k];
    }
    env.FORCE_COLOR = '0';
    env.NO_COLOR = '1';
    return env;
  }

  function killTree(proc) {
    if (!proc || proc.killed) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      } catch (e) {}
    }
    try { proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 4000);
  }

  function stop(id, why) {
    const s = get(id);
    if (!s) throw new Error('сессия не найдена');
    const had = !!s.proc || s.queue.length > 0;
    s.queue.length = 0;
    if (s.proc) {
      s.stopping = true;
      killTree(s.proc);
    }
    if (had) push(s, { role: 'system', text: why || 'остановлено пользователем' });
    return { stopped: had };
  }
  function sendPrompt(id, text, source) {
    const s = get(id);
    if (!s) throw new Error('сессия не найдена');
    const prompt = String(text == null ? '' : text);
    if (!prompt.trim()) throw new Error('пустой запрос');
    push(s, { role: 'user', text: prompt, src: source || 'web' });
    if (s.proc) {
      s.queue.push(prompt);
      touch(s);
      return { queued: s.queue.length, running: true };
    }
    runTurn(s, prompt);
    return { queued: 0, running: true };
  }

  function buildArgs(s) {
    const c = conf();
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (c.stream !== false) args.push('--include-partial-messages');
    if (s.started && s.claudeSessionId) args.push('--resume', s.claudeSessionId);
    else args.push('--session-id', s.id);
    if (s.model) args.push('--model', s.model);
    if (s.permissionMode) args.push('--permission-mode', s.permissionMode);
    if (s.effort) args.push('--effort', s.effort);
    if (Array.isArray(c.extraArgs)) for (const a of c.extraArgs) if (String(a || '').trim()) args.push(String(a));
    return args;
  }

  function runTurn(s, prompt) {
    const c = conf();
    const bin = resolveBin(c.claudeBin);
    const useShell = /\.(cmd|bat)$/i.test(bin);
    let args = buildArgs(s);
    let cmd = bin;
    if (useShell) {
      cmd = quoteArg(bin) + ' ' + args.map(quoteArg).join(' ');
      args = [];
    }
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd: s.cwd,
        env: childEnv(),
        windowsHide: true,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      s.lastError = e.message;
      push(s, { role: 'error', text: 'не удалось запустить claude: ' + e.message });
      s.status = 'idle';
      touch(s);
      return;
    }
    s.proc = proc;
    s.status = 'running';
    s.live = '';
    s.stderr = '';
    s.stopping = false;
    s.sawResult = false;
    s.startedAt = Date.now();
    touch(s);
    log('info', `control: [${s.name}] запуск claude (${s.started ? 'resume' : 'new'}) в ${s.cwd}`);

    const timeoutMs = Math.max(60000, c.turnTimeoutMs || 30 * 60 * 1000);
    const timer = setTimeout(() => {
      push(s, { role: 'error', text: 'таймаут хода (' + Math.round(timeoutMs / 60000) + ' мин) — процесс снят' });
      s.stopping = true;
      killTree(proc);
    }, timeoutMs);

    proc.on('error', e => {
      s.lastError = e.message;
      push(s, { role: 'error', text: 'ошибка процесса claude: ' + e.message });
    });

    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString('utf8');
      if (buf.length > 64 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleLine(s, line);
      }
    });

    proc.stderr.on('data', d => {
      s.stderr = (s.stderr + d.toString('utf8')).slice(-8000);
    });

    proc.stdin.on('error', () => {});
    try {
      proc.stdin.end(prompt, 'utf8');
    } catch (e) {}

    proc.on('close', code => {
      clearTimeout(timer);
      s.proc = null;
      s.status = 'idle';
      s.live = '';
      if (!s.sawResult && !s.stopping) {
        const tail = (s.stderr || '').split('\n').filter(Boolean).slice(-6).join('\n');
        s.lastError = tail || ('claude завершился с кодом ' + code);
        push(s, { role: 'error', text: 'claude завершился с кодом ' + code + (tail ? '\n' + tail : '') });
        // Не удалось подхватить прошлую сессию (файл удалён/переехал) — следующий
        // запрос стартует с чистого листа, чтобы не биться в одну и ту же ошибку.
        if (/no conversation|session.*not found|resume/i.test(tail) || !s.turns) {
          s.started = false;
          s.claudeSessionId = null;
        }
      }
      touch(s);
      persistSoon();
      const next = s.queue.shift();
      if (next) setTimeout(() => runTurn(s, next), 300);
    });
  }
  function handleLine(s, line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'system' && ev.subtype === 'init') {
      s.claudeSessionId = ev.session_id || s.claudeSessionId;
      s.started = true;
      if (ev.model) s.model = s.model || ev.model;
      touch(s);
      return;
    }

    if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        s.live = clip((s.live || '') + e.delta.text, MAX_TEXT);
        emit({ t: 'delta', sessionId: s.id, text: e.delta.text });
      }
      return;
    }

    if (ev.type === 'assistant' && ev.message) {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && String(b.text || '').trim()) {
          push(s, { role: 'assistant', text: b.text, sub: ev.parent_tool_use_id ? 'subagent' : '' });
        } else if (b.type === 'tool_use') {
          push(s, { role: 'tool', text: toolSummary(b.name, b.input), tool: b.name, toolId: b.id });
        }
      }
      const u = ev.message.usage || {};
      s.tokensIn += (u.input_tokens || 0);
      s.tokensOut += (u.output_tokens || 0);
      s.live = '';
      return;
    }

    if (ev.type === 'user' && ev.message) {
      const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_result') {
          const c = b.content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.map(x => (x && x.type === 'text' ? x.text : '[' + (x && x.type) + ']')).join('\n')
            : '';
          push(s, { role: 'tool_result', text: clip(text, 4000), toolId: b.tool_use_id, isError: !!b.is_error });
        }
      }
      return;
    }
    if (ev.type === 'result') {
      s.sawResult = true;
      s.turns += (ev.num_turns || 1);
      s.costUsd += (ev.total_cost_usd || 0);
      const u = ev.usage || {};
      if (u.input_tokens && !s.tokensIn) s.tokensIn += u.input_tokens;
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      if (ev.is_error) {
        s.lastError = clip(ev.result || ev.subtype || 'ошибка', 1000);
        push(s, { role: 'error', text: 'Claude вернул ошибку: ' + s.lastError });
      } else {
        s.lastError = '';
      }
      if (denials.length) {
        const names = denials.map(d => (d && (d.tool_name || d.tool)) || '?').join(', ');
        push(s, {
          role: 'system',
          text: `запрещено правами: ${names}. Смени режим прав (сейчас ${s.permissionMode}) — например на bypassPermissions.`
        });
      }
      push(s, {
        role: 'done',
        text: '',
        costUsd: Math.round((ev.total_cost_usd || 0) * 10000) / 10000,
        durationMs: ev.duration_ms || 0,
        tokensOut: (u.output_tokens || 0)
      });
      s.live = '';
      touch(s);
      persistSoon();
      return;
    }
  }
  function stats() {
    const all = Array.from(sessions.values());
    return {
      sessions: all.length,
      running: all.filter(s => s.proc).length,
      costUsd: Math.round(all.reduce((a, s) => a + (s.costUsd || 0), 0) * 10000) / 10000,
      claudeBin: resolveBin(conf().claudeBin),
      permissionModes: PERMISSION_MODES,
      efforts: EFFORTS
    };
  }

  function shutdown() {
    for (const s of sessions.values()) {
      if (s.proc) {
        s.stopping = true;
        killTree(s.proc);
      }
    }
  }

  restore();

  return {
    onEvent, list, get: id => { const s = get(id); return s ? publicSession(s) : null; },
    createSession, patchSession, deleteSession, clearSession, history,
    sendPrompt, stop, browse, stats, shutdown,
    PERMISSION_MODES, EFFORTS
  };
}

module.exports = { createControl, PERMISSION_MODES, EFFORTS };

