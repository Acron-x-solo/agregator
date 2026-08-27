'use strict';

// Telegram-бот: управление сессиями Claude Code из чата.
// Работает на long polling через https, без внешних зависимостей.

const https = require('https');
const { agentFor } = require('./proxy');

const TG = 'api.telegram.org';
const MAX_TG = 3900;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitMsg(text) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > MAX_TG) {
    let cut = rest.lastIndexOf('\n', MAX_TG);
    if (cut < MAX_TG * 0.5) cut = MAX_TG;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

// Иконки статусов ключей — те же смыслы, что в веб-панели.
const KEY_ICON = {
  ok: '✅', unknown: '⚪', rate_limited: '⏳', down: '🔌', exhausted: '💸', auth_error: '🔑'
};
const KEY_WORD = {
  ok: 'работает', unknown: 'не проверен', rate_limited: 'лимит',
  down: 'недоступен', exhausted: 'исчерпан', auth_error: 'ошибка ключа'
};

function createTelegramBot({ getCfg, save, log, control, getLinks, agg }) {
  const st = {
    running: false,
    offset: 0,
    me: null,
    lastError: '',
    startedAt: 0,
    polls: 0,
    stopFlag: false,
    abort: null
  };
  // Состояние чатов: привязка к сессии + «живое» сообщение прогресса.
  const chats = new Map();
  const conf = () => (getCfg().control && getCfg().control.telegram) || {};

  function chatState(id) {
    const key = String(id);
    if (!chats.has(key)) {
      chats.set(key, { id: key, sessionId: null, live: null, tools: [], answer: [], pending: null });
    }
    return chats.get(key);
  }
  function api(method, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const token = String(conf().botToken || '').trim();
      if (!token) return reject(new Error('не задан токен бота'));
      const body = Buffer.from(JSON.stringify(payload || {}));
      // Если задан прокси — идём через него: api.telegram.org местами недоступен.
      let agent;
      try { agent = agentFor(conf().proxy); }
      catch (e) { return reject(new Error('прокси задан неверно: ' + e.message)); }
      const req = https.request({
        hostname: TG,
        path: '/bot' + token + '/' + method,
        method: 'POST',
        agent: agent || undefined,
        headers: { 'content-type': 'application/json', 'content-length': body.length }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let j;
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { j = null; }
          if (!j) return reject(new Error('битый ответ Telegram (HTTP ' + res.statusCode + ')'));
          if (!j.ok) return reject(new Error(j.description || ('Telegram: HTTP ' + res.statusCode)));
          resolve(j.result);
        });
      });
      req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('таймаут запроса к Telegram')));
      req.on('error', reject);
      if (method === 'getUpdates') st.abort = () => { try { req.destroy(); } catch (e) {} };
      req.end(body);
    });
  }

  function send(chatId, text, extra) {
    const parts = splitMsg(text);
    let chain = Promise.resolve(null);
    parts.forEach((p, idx) => {
      chain = chain.then(prev => api('sendMessage', Object.assign({
        chat_id: chatId,
        text: p,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      }, idx === parts.length - 1 ? (extra || {}) : {})).catch(e => {
        log('warn', 'telegram: sendMessage — ' + e.message);
        return prev;
      }));
    });
    return chain;
  }

  function editMsg(chatId, msgId, text, extra) {
    return api('editMessageText', Object.assign({
      chat_id: chatId,
      message_id: msgId,
      text: text.slice(0, MAX_TG),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    }, extra || {})).catch(e => {
      if (!/not modified/i.test(e.message)) log('warn', 'telegram: editMessageText — ' + e.message);
    });
  }
  function allowed() {
    const raw = conf().allowedChatIds;
    return (Array.isArray(raw) ? raw : []).map(String);
  }

  function isAllowed(chatId) {
    return allowed().includes(String(chatId));
  }

  function authorize(chatId) {
    const c = getCfg().control.telegram;
    c.allowedChatIds = Array.isArray(c.allowedChatIds) ? c.allowedChatIds : [];
    if (!c.allowedChatIds.map(String).includes(String(chatId))) {
      c.allowedChatIds.push(String(chatId));
      save();
      log('info', 'telegram: чат авторизован — ' + chatId);
    }
  }

  function revoke(chatId) {
    const c = getCfg().control.telegram;
    c.allowedChatIds = (Array.isArray(c.allowedChatIds) ? c.allowedChatIds : []).filter(x => String(x) !== String(chatId));
    save();
  }

  function saveBinding(chatId, sessionId) {
    const c = getCfg().control.telegram;
    c.bindings = c.bindings && typeof c.bindings === 'object' ? c.bindings : {};
    if (sessionId) c.bindings[String(chatId)] = sessionId;
    else delete c.bindings[String(chatId)];
    save();
  }

  function loadBindings() {
    const b = conf().bindings || {};
    for (const [chatId, sessionId] of Object.entries(b)) {
      if (control.get(sessionId)) chatState(chatId).sessionId = sessionId;
    }
  }

  function activeSession(chat) {
    if (chat.sessionId && control.get(chat.sessionId)) return control.get(chat.sessionId);
    chat.sessionId = null;
    return null;
  }

  const kbRun = { inline_keyboard: [[{ text: '⏹ Стоп', callback_data: 'stop' }, { text: '🔄 Статус', callback_data: 'status' }]] };

  function kbSessions() {
    const rows = control.list().slice(0, 12).map(s => [{
      text: (s.status === 'running' ? '▶ ' : '') + s.name + ' · ' + shortId(s.id),
      callback_data: 'use:' + s.id
    }]);
    rows.push([{ text: '➕ Новая сессия', callback_data: 'new' }]);
    return { inline_keyboard: rows };
  }
  function chatsFor(sessionId) {
    return Array.from(chats.values()).filter(c => c.sessionId === sessionId);
  }

  function renderProgress(chat) {
    const s = control.get(chat.sessionId) || {};
    const head = `⏳ <b>${esc(s.name || 'сессия')}</b>${s.model ? ' · ' + esc(s.model) : ''}`;
    const tools = chat.tools.slice(-6).map(t => '🔧 ' + esc(t));
    const more = chat.tools.length > 6 ? `… и ещё ${chat.tools.length - 6} шагов` : '';
    const live = (chat.liveText || '').slice(-900);
    const parts = [head];
    if (chat.promptEcho) parts.push('<i>» ' + esc(chat.promptEcho.slice(0, 300)) + '</i>');
    if (tools.length) parts.push(tools.join('\n') + (more ? '\n' + more : ''));
    if (live.trim()) parts.push(esc(live));
    return parts.join('\n\n').slice(0, MAX_TG);
  }

  async function beginProgress(chat, promptEcho, fromWeb) {
    chat.tools = [];
    chat.answer = [];
    chat.liveText = '';
    chat.promptEcho = fromWeb ? promptEcho : '';
    chat.startAt = Date.now();
    chat.dirty = false;
    try {
      const m = await api('sendMessage', {
        chat_id: chat.id,
        text: renderProgress(chat),
        parse_mode: 'HTML',
        reply_markup: kbRun,
        link_preview_options: { is_disabled: true }
      });
      chat.live = { msgId: m.message_id, lastEdit: Date.now() };
    } catch (e) {
      chat.live = null;
      log('warn', 'telegram: не удалось начать прогресс — ' + e.message);
    }
  }

  async function finalize(chat) {
    const s = control.get(chat.sessionId) || {};
    const answer = chat.answer.join('\n\n').trim();
    const secs = chat.startAt ? Math.round((Date.now() - chat.startAt) / 1000) : 0;
    const footer = `\n\n<i>✅ ${chat.tools.length} инстр. · ${secs} с · $${(s.costUsd || 0).toFixed(4)}</i>`;
    const text = (answer ? esc(answer) : '<i>готово, текстового ответа нет</i>') + footer;
    const parts = splitMsg(text);
    if (chat.live) {
      await editMsg(chat.id, chat.live.msgId, parts[0], { reply_markup: { inline_keyboard: [] } });
      for (const p of parts.slice(1)) await send(chat.id, p);
    } else {
      await send(chat.id, text);
    }
    chat.live = null;
    chat.liveText = '';
  }
  // Подписка на события пульта: ведём «живое» сообщение в каждом привязанном чате.
  control.onEvent(ev => {
    if (!st.running) return;
    const targets = chatsFor(ev.sessionId);
    if (!targets.length) return;
    for (const chat of targets) {
      if (ev.t === 'msg') {
        const m = ev.msg;
        if (m.role === 'user') {
          if (!chat.live) beginProgress(chat, m.text, m.src !== 'telegram');
        } else if (m.role === 'tool') {
          chat.tools.push(m.tool + (m.text ? ' · ' + m.text.slice(0, 120) : ''));
          chat.dirty = true;
        } else if (m.role === 'assistant') {
          chat.answer.push(m.text);
          chat.liveText = '';
          chat.dirty = true;
        } else if (m.role === 'error') {
          chat.answer.push('⚠️ ' + m.text);
          chat.dirty = true;
        } else if (m.role === 'system' && /запрещено правами|таймаут/.test(m.text || '')) {
          chat.answer.push('ℹ️ ' + m.text);
        } else if (m.role === 'done') {
          finalize(chat);
        }
      } else if (ev.t === 'delta') {
        chat.liveText = (chat.liveText || '') + ev.text;
        chat.dirty = true;
      } else if (ev.t === 'removed') {
        chat.sessionId = null;
        saveBinding(chat.id, null);
      }
    }
  });

  // Один таймер на всех: правим сообщения не чаще, чем раз в 2.5 с.
  setInterval(() => {
    if (!st.running) return;
    for (const chat of chats.values()) {
      if (!chat.live || !chat.dirty) continue;
      if (Date.now() - chat.live.lastEdit < 2500) continue;
      chat.dirty = false;
      chat.live.lastEdit = Date.now();
      editMsg(chat.id, chat.live.msgId, renderProgress(chat), { reply_markup: kbRun });
    }
  }, 1200).unref();
  const BOT_CMDS = new Set(['/start', '/help', '/auth', '/new', '/sessions', '/use', '/cd', '/ls',
    '/model', '/mode', '/effort', '/stop', '/clear', '/status', '/cost', '/del', '/id', '/p', '/panel',
    '/keys', '/key', '/ping', '/reset', '/autoping']);

  const HELP = [
    '<b>Пульт Claude Code</b>',
    '',
    'Просто пиши текст — он уйдёт в активную сессию Claude Code.',
    '',
    '/new [имя] — новая сессия',
    '/sessions — список и переключение',
    '/use &lt;id&gt; — выбрать сессию',
    '/cd &lt;путь&gt; — сменить рабочую папку',
    '/ls [путь] — посмотреть папки',
    '/model [имя] — модель (пусто — по умолчанию)',
    '/mode &lt;режим&gt; — права: acceptEdits, bypassPermissions, plan, dontAsk, auto, manual',
    '/effort &lt;low|medium|high|xhigh|max&gt; — усилие',
    '/stop — прервать текущий ход',
    '/clear — очистить контекст сессии',
    '/status — состояние, /cost — расходы',
    '/panel — ссылки на веб-панель и на ключи',
    '/del — удалить сессию',
    '/p &lt;текст&gt; — послать текст как запрос (если начинается со слэша)',
    '',
    '<b>Ключи агрегатора</b>',
    '/keys — список ключей и их состояние',
    '/key &lt;номер|имя&gt; — сделать ключ активным',
    '/ping — проверить ключи прямо сейчас',
    '/reset — снять все «мёртвые» отметки',
    '/autoping [on|off|&lt;минуты&gt;] — авто-пинг ключей'
  ].join('\n');

  // ─── ключи агрегатора ───
  const kbKeys = () => ({
    inline_keyboard: [[
      { text: '♻️ Пинг', callback_data: 'kping' },
      { text: '🧹 Сброс', callback_data: 'kreset' },
      { text: '🔄 Обновить', callback_data: 'keys' }
    ]]
  });

  function fmtAgoRu(ts) {
    if (!ts) return 'не было';
    const d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.round(d / 1000)) + ' с назад';
    if (d < 3600000) return Math.round(d / 60000) + ' мин назад';
    return Math.round(d / 3600000) + ' ч назад';
  }
  function fmtInRu(ts) {
    if (!ts) return '—';
    const d = ts - Date.now();
    if (d <= 0) return 'вот-вот';
    if (d < 60000) return 'через ' + Math.max(1, Math.round(d / 1000)) + ' с';
    const m = Math.floor(d / 60000);
    const s = Math.round((d % 60000) / 1000);
    return 'через ' + m + ' мин' + (s ? ' ' + s + ' с' : '');
  }

  function keyList() {
    return agg && agg.summary ? (agg.summary().providers || []) : [];
  }

  // Ключ можно назвать номером из /keys, именем или его началом.
  function findKey(arg) {
    const list = keyList();
    const n = parseInt(arg, 10);
    if (String(n) === arg.trim() && n >= 1 && n <= list.length) return list[n - 1];
    const low = arg.trim().toLowerCase();
    return list.find(p => p.id === arg) ||
      list.find(p => String(p.name).toLowerCase() === low) ||
      list.find(p => String(p.name).toLowerCase().startsWith(low)) || null;
  }

  function fmtAutoPing(a) {
    if (!a) return 'авто-пинг недоступен';
    const out = [`⏱ Авто-пинг: <b>${a.enabled ? 'включён' : 'выключен'}</b>`];
    if (a.enabled) {
      out.push(`интервал ${Math.round(a.intervalMs / 60000)} мин · охват ${a.scope === 'all' ? 'все ключи' : 'только проблемные'}` +
        (a.includeSticky ? ' (включая снятые)' : ''));
      if (a.busy) out.push('сейчас идёт проверка');
      else if (a.nextRunAt) out.push('следующий проход ' + fmtInRu(a.nextRunAt));
    }
    if (a.lastRunAt && a.last) {
      out.push(`последний проход ${fmtAgoRu(a.lastRunAt)}: проверено ${a.last.checked}, живых ${a.last.ok}` +
        (a.last.revived && a.last.revived.length ? ', ожили: ' + esc(a.last.revived.join(', ')) : ''));
    }
    out.push(`в очереди на проверку: ${a.pending || 0}`);
    return out.join('\n');
  }

  function fmtKeys() {
    if (!agg || !agg.summary) return 'агрегатор недоступен';
    const s = agg.summary();
    const list = s.providers || [];
    if (!list.length) return 'Ключей нет — добавь их в панели, раздел «Ключи».';
    const out = [`<b>Ключи</b> · живых ${s.ok} из ${s.total} · стратегия ${esc(s.strategy)}`];
    const a = s.autoPing;
    out.push(a && a.enabled
      ? `авто-пинг каждые ${Math.round(a.intervalMs / 60000)} мин · последний ${fmtAgoRu(a.lastRunAt)}`
      : 'авто-пинг выключен');
    out.push('');
    list.forEach((p, i) => {
      const tail = [KEY_WORD[p.status] || p.status];
      if (p.sticky) tail.push('снят до сброса');
      if (p.cooldownLeft) tail.push('пауза ' + Math.ceil(p.cooldownLeft / 1000) + ' с');
      if (p.latency) tail.push(p.latency + ' мс');
      if (p.enabled === false) tail.push('выключен');
      out.push(`${i + 1}. ${KEY_ICON[p.status] || '⚪'} <b>${esc(p.name)}</b>${p.active ? ' ⭐' : ''}`);
      out.push('    <i>' + esc(tail.join(' · ')) + '</i>');
    });
    out.push('');
    out.push('<i>/key номер — сделать активным · /ping — проверить сейчас</i>');
    return out.join('\n');
  }

  function fmtRun(r) {
    if (!r) return 'нет данных';
    if (r.error) return '⚠️ ' + esc(r.error);
    if (r.busy) return '⏳ Проверка уже идёт — подожди немного.';
    const out = [`♻️ Проверено ${r.checked}, живых ${r.ok}, с ошибкой ${r.failed} · ${Math.round((r.ms || 0) / 1000)} с`];
    if (r.revived && r.revived.length) out.push('Ожили: <b>' + esc(r.revived.join(', ')) + '</b>');
    const bad = (r.results || []).filter(x => !x.ok).slice(0, 8);
    if (bad.length) {
      out.push('');
      out.push(bad.map(x => '• ' + esc(x.name) + ' — ' + esc(String(x.info || '').slice(0, 90))).join('\n'));
    }
    return out.join('\n');
  }

  function pingAndReport(chatId) {
    if (!agg || !agg.pingNow) return send(chatId, 'авто-пинг недоступен');
    return new Promise(resolve => {
      agg.pingNow(r => resolve(send(chatId, fmtRun(r), { reply_markup: kbKeys() })));
    });
  }

  function fmtSession(s) {
    if (!s) return 'сессия не выбрана';
    return [
      `<b>${esc(s.name)}</b> · <code>${shortId(s.id)}</code>`,
      `папка: <code>${esc(s.cwd)}</code>`,
      `модель: ${esc(s.model || 'по умолчанию')} · права: ${esc(s.permissionMode)}${s.effort ? ' · усилие: ' + esc(s.effort) : ''}`,
      `статус: ${s.status === 'running' ? 'работает' : 'ожидает'}${s.queued ? ' · в очереди ' + s.queued : ''}`,
      `ходов: ${s.turns} · $${(s.costUsd || 0).toFixed(4)} · токены ${s.tokensIn}/${s.tokensOut}`
    ].join('\n');
  }

  function ensureSession(chat, opts) {
    let s = activeSession(chat);
    if (s) return s;
    s = control.createSession(opts || {});
    chat.sessionId = s.id;
    saveBinding(chat.id, s.id);
    return s;
  }
  async function handleText(chatId, raw) {
    const chat = chatState(chatId);
    const text = String(raw || '').trim();
    if (!text) return;
    const first = text.split(/\s+/)[0];
    const cmd = first.toLowerCase().replace(/@[\w_]+$/, '');
    const arg = text.slice(first.length).trim();
    const isCmd = BOT_CMDS.has(cmd);

    if (!isAllowed(chatId)) {
      // Подойдёт короткий код привязки или полный токен панели.
      const secrets = [String(conf().pairingCode || '').trim(), String(getCfg().control.token || '').trim()]
        .filter(Boolean);
      if (cmd === '/auth' && arg && secrets.includes(arg)) {
        authorize(chatId);
        return send(chatId, '✅ Доступ открыт.\n\n' + HELP);
      }
      return send(chatId, `🔒 Нет доступа. Твой chat id: <code>${chatId}</code>\n\nПришли <code>/auth КОД</code> (код — в веб-панели, раздел «Telegram») или добавь этот chat id в список разрешённых.`);
    }

    if (!isCmd) return promptTo(chat, text);

    switch (cmd) {
      case '/start':
      case '/help':
        return send(chatId, HELP + '\n\n' + fmtSession(activeSession(chat)));
      case '/auth':
        return send(chatId, '✅ Этот чат уже авторизован.');
      case '/id':
        return send(chatId, `chat id: <code>${chatId}</code>`);
      case '/panel': {
        const links = (getLinks && getLinks()) || {};
        const lines = ['<b>Веб-панель</b>'];
        if (links.tunnelUrl) lines.push('внешний адрес: ' + esc(links.tunnelUrl));
        if (links.keysUrl) lines.push('ключи снаружи: ' + esc(links.keysUrl));
        if (links.localUrl) lines.push('локально: ' + esc(links.localUrl));
        if (links.localKeysUrl) lines.push('ключи локально: ' + esc(links.localKeysUrl));
        if (links.token) lines.push('токен входа: <code>' + esc(links.token) + '</code>');
        if (!links.tunnelUrl) lines.push('<i>туннель Cloudflare не запущен — снаружи не зайти</i>');
        return send(chatId, lines.join('\n'));
      }
      case '/keys':
        return send(chatId, fmtKeys(), { reply_markup: kbKeys() });
      case '/key': {
        if (!agg || !agg.activate) return send(chatId, 'агрегатор недоступен');
        if (!arg) return send(chatId, 'Укажи номер или имя ключа: <code>/key 3</code>\nСписок — /keys');
        const p = findKey(arg);
        if (!p) return send(chatId, 'Ключ не найден. Список — /keys');
        const r = agg.activate(p.id);
        return send(chatId, r.ok ? '⭐ Активный ключ: <b>' + esc(r.name) + '</b>' : '⚠️ ' + esc(r.error || 'не получилось'),
          { reply_markup: kbKeys() });
      }
      case '/ping':
        await send(chatId, '♻️ Проверяю ключи...');
        return pingAndReport(chatId);
      case '/reset': {
        if (!agg || !agg.resetAll) return send(chatId, 'агрегатор недоступен');
        const r = agg.resetAll();
        return send(chatId, '🧹 Снято отметок: ' + (r.reset || 0) + '\n\n' + fmtKeys(), { reply_markup: kbKeys() });
      }
      case '/autoping': {
        if (!agg || !agg.setAutoPing) return send(chatId, 'авто-пинг недоступен');
        if (!arg) return send(chatId, fmtAutoPing(agg.autoPing()), { reply_markup: kbKeys() });
        const low = arg.trim().toLowerCase();
        const num = parseFloat(low.replace(',', '.'));
        let patch = null;
        if (['on', 'вкл', '1', 'да'].includes(low)) patch = { enabled: true };
        else if (['off', 'выкл', '0', 'нет'].includes(low)) patch = { enabled: false };
        else if (Number.isFinite(num) && num > 0) patch = { enabled: true, intervalMin: Math.max(0.5, num) };
        if (!patch) return send(chatId, 'Как пользоваться: <code>/autoping on</code>, <code>/autoping off</code> или <code>/autoping 15</code> (минуты)');
        return send(chatId, fmtAutoPing(agg.setAutoPing(patch)), { reply_markup: kbKeys() });
      }
      case '/p':
        if (!arg) return send(chatId, 'после /p нужен текст запроса');
        return promptTo(chat, arg);
      case '/new': {
        const s = control.createSession({ name: arg || '' });
        chat.sessionId = s.id;
        saveBinding(chatId, s.id);
        return send(chatId, '🆕 Сессия создана.\n\n' + fmtSession(s));
      }
      case '/sessions': {
        const list = control.list();
        if (!list.length) return send(chatId, 'Сессий нет. Создай: /new', { reply_markup: kbSessions() });
        const body = list.map(s => `${s.id === chat.sessionId ? '➡️' : '▫️'} <b>${esc(s.name)}</b> · <code>${shortId(s.id)}</code> · ${esc(s.cwd)}`).join('\n');
        return send(chatId, body, { reply_markup: kbSessions() });
      }
      case '/use': {
        if (!arg) return send(chatId, 'Укажи id сессии или выбери кнопкой: /sessions');
        const hit = control.list().find(s => s.id === arg || shortId(s.id) === arg || s.name === arg);
        if (!hit) return send(chatId, 'Сессия не найдена');
        chat.sessionId = hit.id;
        saveBinding(chatId, hit.id);
        return send(chatId, '➡️ Активная сессия:\n\n' + fmtSession(hit));
      }
      case '/cd': {
        if (!arg) return send(chatId, 'Укажи путь: /cd C:\\projects\\my-app');
        try {
          const s = activeSession(chat)
            ? control.patchSession(chat.sessionId, { cwd: arg })
            : ensureSession(chat, { cwd: arg });
          return send(chatId, '📁 Папка: <code>' + esc(s.cwd) + '</code>\n<i>контекст начат заново</i>');
        } catch (e) {
          return send(chatId, '⚠️ ' + esc(e.message));
        }
      }
      case '/ls': {
        try {
          const s = activeSession(chat);
          const r = control.browse(arg || (s ? s.cwd : ''));
          chat.lsCache = [];
          const rows = [];
          if (r.parent) { chat.lsCache.push(r.parent); rows.push([{ text: '⬆️ ..', callback_data: 'cd:0' }]); }
          for (const d of r.dirs.slice(0, 24)) {
            chat.lsCache.push(d.path);
            rows.push([{ text: '📁 ' + d.name, callback_data: 'cd:' + (chat.lsCache.length - 1) }]);
          }
          return send(chatId, '<code>' + esc(r.path) + '</code>\nвыбери папку — она станет рабочей:', { reply_markup: { inline_keyboard: rows } });
        } catch (e) {
          return send(chatId, '⚠️ ' + esc(e.message));
        }
      }
      case '/model':
      case '/mode':
      case '/effort': {
        const s = activeSession(chat) || ensureSession(chat);
        const field = cmd === '/model' ? 'model' : cmd === '/mode' ? 'permissionMode' : 'effort';
        if (cmd === '/mode' && arg && !control.PERMISSION_MODES.includes(arg)) {
          return send(chatId, 'Режимы: ' + control.PERMISSION_MODES.join(', '));
        }
        if (cmd === '/effort' && arg && !control.EFFORTS.includes(arg)) {
          return send(chatId, 'Усилие: ' + control.EFFORTS.filter(Boolean).join(', '));
        }
        try {
          const upd = control.patchSession(s.id, { [field]: arg });
          return send(chatId, fmtSession(upd));
        } catch (e) {
          return send(chatId, '⚠️ ' + esc(e.message));
        }
      }
      case '/stop': {
        const s = activeSession(chat);
        if (!s) return send(chatId, 'Сессия не выбрана');
        const r = control.stop(s.id, 'остановлено из Telegram');
        return send(chatId, r.stopped ? '⏹ Остановлено' : 'Сейчас ничего не выполняется');
      }
      case '/clear': {
        const s = activeSession(chat);
        if (!s) return send(chatId, 'Сессия не выбрана');
        try {
          control.clearSession(s.id);
          return send(chatId, '🧹 Контекст очищен');
        } catch (e) {
          return send(chatId, '⚠️ ' + esc(e.message));
        }
      }
      case '/del': {
        const s = activeSession(chat);
        if (!s) return send(chatId, 'Сессия не выбрана');
        control.deleteSession(s.id);
        chat.sessionId = null;
        saveBinding(chatId, null);
        return send(chatId, '🗑 Сессия удалена');
      }
      case '/cost': {
        const all = control.list();
        const total = all.reduce((a, s) => a + (s.costUsd || 0), 0);
        const body = all.map(s => `${esc(s.name)}: $${(s.costUsd || 0).toFixed(4)} · ${s.turns} ходов`).join('\n');
        return send(chatId, `<b>Расходы</b>\nвсего: $${total.toFixed(4)}\n\n${body || '—'}`);
      }
      case '/status': {
        const links = (getLinks && getLinks()) || {};
        const cs = control.stats() || {};
        const ap = agg && agg.autoPing ? agg.autoPing() : null;
        const lines = [
          '<b>Состояние</b>',
          `сессии: ${cs.sessions || 0} (работают: ${cs.running || 0}) · расходы: $${(cs.costUsd || 0).toFixed(4)}`,
          links.aggregator ? `ключи: ${links.aggregator.ok}/${links.aggregator.total} живых · активный: ${esc(links.aggregator.active || '—')}` : '',
          ap ? `авто-пинг: ${ap.enabled ? 'каждые ' + Math.round(ap.intervalMs / 60000) + ' мин · последний ' + fmtAgoRu(ap.lastRunAt) : 'выключен'}` : '',
          links.tunnelUrl ? 'панель: ' + esc(links.tunnelUrl) : 'туннель Cloudflare: выключен',
          links.keysUrl ? 'ключи: ' + esc(links.keysUrl) : '',
          '',
          fmtSession(activeSession(chat))
        ].filter(Boolean);
        return send(chatId, lines.join('\n'), { reply_markup: activeSession(chat) && activeSession(chat).status === 'running' ? kbRun : undefined });
      }
    }
  }

  function promptTo(chat, text) {
    let s;
    try {
      s = activeSession(chat) || ensureSession(chat);
    } catch (e) {
      return send(chat.id, '⚠️ не удалось создать сессию: ' + esc(e.message));
    }
    try {
      const r = control.sendPrompt(s.id, text, 'telegram');
      if (r.queued) return send(chat.id, `⏳ Занято, запрос в очереди (${r.queued})`);
    } catch (e) {
      return send(chat.id, '⚠️ ' + esc(e.message));
    }
  }
  async function handleCallback(q) {
    const chatId = q.message && q.message.chat ? q.message.chat.id : null;
    if (chatId == null) return;
    const chat = chatState(chatId);
    const data = String(q.data || '');
    const ack = text => api('answerCallbackQuery', { callback_query_id: q.id, text: text || '' }).catch(() => {});
    if (!isAllowed(chatId)) return ack('нет доступа');

    if (data === 'stop') {
      const s = activeSession(chat);
      if (!s) return ack('нет сессии');
      control.stop(s.id, 'остановлено из Telegram');
      return ack('остановлено');
    }
    if (data === 'status') {
      await ack('');
      return handleText(chatId, '/status');
    }
    if (data === 'keys') {
      await ack('');
      return send(chatId, fmtKeys(), { reply_markup: kbKeys() });
    }
    if (data === 'kping') {
      await ack('проверяю...');
      return pingAndReport(chatId);
    }
    if (data === 'kreset') {
      if (!agg || !agg.resetAll) return ack('недоступно');
      const r = agg.resetAll();
      await ack('снято: ' + (r.reset || 0));
      return send(chatId, '🧹 Снято отметок: ' + (r.reset || 0) + '\n\n' + fmtKeys(), { reply_markup: kbKeys() });
    }
    if (data === 'new') {
      const s = control.createSession({});
      chat.sessionId = s.id;
      saveBinding(chatId, s.id);
      await ack('создана');
      return send(chatId, '🆕 Сессия создана.\n\n' + fmtSession(s));
    }
    if (data.startsWith('use:')) {
      const id = data.slice(4);
      if (!control.get(id)) return ack('сессия исчезла');
      chat.sessionId = id;
      saveBinding(chatId, id);
      await ack('переключено');
      return send(chatId, '➡️ ' + fmtSession(control.get(id)));
    }
    if (data.startsWith('cd:')) {
      const idx = parseInt(data.slice(3), 10);
      const p = (chat.lsCache || [])[idx];
      if (!p) return ack('путь устарел');
      await ack('');
      return handleText(chatId, '/cd ' + p);
    }
    return ack('');
  }

  function handleUpdate(u) {
    // Обработчики асинхронные: без перехвата любой сбой в команде уронил бы
    // весь процесс через unhandledRejection.
    const guard = p => {
      try { Promise.resolve(p).catch(e => log('warn', 'telegram: сбой обработки — ' + e.message)); }
      catch (e) { log('warn', 'telegram: сбой обработки — ' + e.message); }
    };
    try {
      if (u.callback_query) return guard(handleCallback(u.callback_query));
      const m = u.message || u.edited_message;
      if (!m || !m.chat) return;
      if (typeof m.text === 'string' && m.text.trim()) return guard(handleText(m.chat.id, m.text));
      if (m.caption) return guard(handleText(m.chat.id, m.caption));
    } catch (e) {
      log('warn', 'telegram: сбой обработки апдейта — ' + e.message);
    }
  }
  async function loop() {
    let backoff = 1000;
    while (st.running) {
      try {
        const updates = await api('getUpdates', {
          offset: st.offset,
          timeout: 45,
          allowed_updates: ['message', 'edited_message', 'callback_query']
        }, 70000);
        st.polls++;
        st.lastError = '';
        backoff = 1000;
        for (const u of updates || []) {
          st.offset = Math.max(st.offset, (u.update_id || 0) + 1);
          handleUpdate(u);
        }
      } catch (e) {
        if (!st.running) break;
        st.lastError = e.message;
        if (/409|conflict/i.test(e.message)) {
          log('warn', 'telegram: конфликт getUpdates — бот запущен ещё где-то. Пауза 30 с');
          backoff = 30000;
        } else if (/401|unauthorized/i.test(e.message)) {
          log('warn', 'telegram: неверный токен бота — polling остановлен');
          st.running = false;
          break;
        } else if (!/таймаут/i.test(e.message)) {
          log('warn', 'telegram: ' + e.message);
        }
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }

  async function start() {
    if (st.running) return status();
    if (!String(conf().botToken || '').trim()) {
      st.lastError = 'не задан токен бота';
      return status();
    }
    st.running = true;
    st.stopFlag = false;
    st.startedAt = Date.now();
    try {
      st.me = await api('getMe', {}, 15000);
      log('info', `telegram: бот @${st.me.username} подключён`);
    } catch (e) {
      st.running = false;
      st.lastError = /таймаут/.test(e.message) && !String(conf().proxy || '').trim()
        ? e.message + ' — похоже, api.telegram.org недоступен напрямую, укажи прокси'
        : e.message;
      log('warn', 'telegram: не удалось подключиться — ' + st.lastError);
      return status();
    }
    try { await api('deleteWebhook', { drop_pending_updates: false }, 10000); } catch (e) {}
    loadBindings();
    loop();
    for (const chatId of allowed()) {
      send(chatId, '🟢 Пульт Claude Code на связи. /help — команды.');
    }
    return status();
  }
  function stop() {
    if (!st.running) return status();
    st.running = false;
    if (st.abort) { try { st.abort(); } catch (e) {} }
    log('info', 'telegram: polling остановлен');
    return status();
  }

  function status() {
    return {
      running: st.running,
      enabled: conf().enabled !== false,
      hasToken: !!String(conf().botToken || '').trim(),
      pairingCode: String(conf().pairingCode || ''),
      proxy: String(conf().proxy || ''),
      username: st.me ? st.me.username : '',
      allowedChatIds: allowed(),
      bindings: Array.from(chats.values()).filter(c => c.sessionId).map(c => ({ chatId: c.id, sessionId: c.sessionId })),
      startedAt: st.startedAt,
      polls: st.polls,
      lastError: st.lastError
    };
  }

  // Оповещения от агрегатора (ожившие ключи, новый адрес туннеля) — во все
  // авторизованные чаты. Текст приходит обычный, поэтому экранируем.
  function broadcast(text) {
    if (!st.running) return;
    const body = esc(String(text || ''));
    if (!body.trim()) return;
    for (const chatId of allowed()) send(chatId, body);
  }

  return { start, stop, status, authorize, revoke, broadcast, notify: (chatId, text) => send(chatId, text) };
}

module.exports = { createTelegramBot };

