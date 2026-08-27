'use strict';

// Авто-пинг ключей: раз в N минут прогоняет проверку провайдеров, оживляет те,
// что снова отвечают, и не даёт «снятым до ручного сброса» висеть мёртвым грузом.
// Про HTTP модуль не знает — проверку выполняет testProvider из server.js.

const DEFAULTS = {
  enabled: true,
  intervalMs: 10 * 60 * 1000,
  concurrency: 4,
  scope: 'broken',           // broken — только проблемные, all — все ключи
  includeSticky: true,       // проверять и «снятые до ручного сброса»
  includeDisabled: false,
  notifyTelegram: true,
  startupDelayMs: 20000
};

const SCOPES = ['broken', 'all'];
const MIN_INTERVAL = 30 * 1000;
const DEAD_ALERT_EVERY = 60 * 60 * 1000;

function normalizeAutoPing(raw) {
  const a = Object.assign({}, DEFAULTS, raw || {});
  a.enabled = a.enabled !== false;
  a.intervalMs = Math.max(MIN_INTERVAL, Number(a.intervalMs) || DEFAULTS.intervalMs);
  a.concurrency = Math.min(16, Math.max(1, Number(a.concurrency) || DEFAULTS.concurrency));
  if (!SCOPES.includes(a.scope)) a.scope = DEFAULTS.scope;
  a.includeSticky = a.includeSticky !== false;
  a.includeDisabled = a.includeDisabled === true;
  a.notifyTelegram = a.notifyTelegram !== false;
  a.startupDelayMs = Math.max(0, Number(a.startupDelayMs) || 0);
  return a;
}

function isSticky(p) {
  return p.sticky === true || p.status === 'exhausted' || p.status === 'auth_error';
}

function createHealthcheck({ getCfg, log, testProvider, notify, onDone }) {
  const st = {
    busy: false, runs: 0, lastRunAt: 0, lastMs: 0, nextRunAt: 0,
    last: null, deadNotifiedAt: 0
  };
  let timer = null;

  const conf = () => normalizeAutoPing(getCfg().autoPing);

  // Кого проверяем в этот проход.
  function pick() {
    const c = conf();
    const now = Date.now();
    return (getCfg().providers || []).filter(p => {
      if (!p.apiKey || !p.baseUrl) return false;
      if (p.enabled === false && !c.includeDisabled) return false;
      const sticky = isSticky(p);
      if (sticky && !c.includeSticky) return false;
      if (c.scope === 'broken') {
        if (p.status === 'ok') return false;
        // короткий cooldown истечёт сам — не тратим на него проверку
        if (!sticky && p.cooldownUntil && p.cooldownUntil > now) return false;
      }
      return true;
    });
  }

  function report(revived) {
    const c = conf();
    if (!c.notifyTelegram || typeof notify !== 'function') return;
    const all = (getCfg().providers || []).filter(p => p.enabled !== false);
    const alive = all.filter(p => p.status === 'ok').length;
    if (revived.length) {
      notify('♻️ Авто-пинг оживил ключи: ' + revived.map(r => r.name).join(', ') +
        `\nживых сейчас: ${alive} из ${all.length}`);
    }
    if (!alive && all.length && Date.now() - st.deadNotifiedAt > DEAD_ALERT_EVERY) {
      st.deadNotifiedAt = Date.now();
      notify('⚠️ Живых ключей не осталось — все провайдеры отвечают ошибкой. Проверь /keys в панели.');
    }
    if (alive) st.deadNotifiedAt = 0;
  }

  function run(reason, cb) {
    if (st.busy) { if (cb) cb(Object.assign({ busy: true }, st.last || {})); return; }
    const c = conf();
    const list = pick();
    const before = new Map(list.map(p => [p.id, p.status]));
    const results = [];
    const started = Date.now();
    let launched = 0, finished = 0, running = 0;
    st.busy = true;

    const finish = () => {
      st.busy = false;
      st.runs++;
      st.lastRunAt = Date.now();
      st.lastMs = Date.now() - started;
      const okc = results.filter(r => r.ok).length;
      const revived = results.filter(r => r.ok && before.get(r.id) !== 'ok');
      st.last = {
        at: st.lastRunAt, reason: reason || '', ms: st.lastMs,
        checked: results.length, ok: okc, failed: results.length - okc,
        revived: revived.map(r => r.name), results
      };
      if (results.length) {
        log('info', `авто-пинг (${reason}): проверено ${results.length}, живых ${okc}` +
          (revived.length ? ', ожили: ' + revived.map(r => r.name).join(', ') : ''));
      }
      try { report(revived); } catch (e) {}
      schedule();
      if (typeof onDone === 'function') { try { onDone(st.last); } catch (e) {} }
      if (cb) cb(st.last);
    };

    if (!list.length) return finish();

    const pump = () => {
      while (running < c.concurrency && launched < list.length) {
        const p = list[launched++];
        running++;
        let closed = false;
        try {
          testProvider(p, r => {
            if (closed) return;
            closed = true;
            results.push({ id: p.id, name: p.name, ok: !!(r && r.ok), info: (r && r.info) || '' });
            running--; finished++;
            if (finished >= list.length) finish();
            else setImmediate(pump);
          });
        } catch (e) {
          closed = true;
          results.push({ id: p.id, name: p.name, ok: false, info: e.message });
          running--; finished++;
          if (finished >= list.length) return finish();
        }
      }
    };
    pump();
  }

  function arm(delay, reason) {
    if (timer) { clearTimeout(timer); timer = null; }
    st.nextRunAt = Date.now() + delay;
    timer = setTimeout(() => { timer = null; run(reason); }, delay);
    if (timer.unref) timer.unref();
  }

  function schedule() {
    const c = conf();
    if (!c.enabled) {
      if (timer) { clearTimeout(timer); timer = null; }
      st.nextRunAt = 0;
      return;
    }
    arm(c.intervalMs, 'по расписанию');
  }

  function start() {
    const c = conf();
    if (!c.enabled) {
      log('info', 'авто-пинг ключей выключен (autoPing.enabled = false)');
      return status();
    }
    arm(c.startupDelayMs || 1000, 'старт');
    log('info', `авто-пинг ключей включён: каждые ${Math.round(c.intervalMs / 60000)} мин, охват — ` +
      (c.scope === 'all' ? 'все ключи' : 'только проблемные') +
      (c.includeSticky ? ', включая снятые' : ''));
    return status();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    st.nextRunAt = 0;
    return status();
  }

  function status() {
    const c = conf();
    return Object.assign({}, c, {
      busy: st.busy,
      runs: st.runs,
      lastRunAt: st.lastRunAt,
      lastMs: st.lastMs,
      nextRunAt: st.nextRunAt,
      pending: pick().length,
      last: st.last
    });
  }

  // Меняли настройки — пересобираем таймер под новый интервал.
  function reschedule() {
    const c = conf();
    if (!c.enabled) return stop();
    schedule();
    return status();
  }

  return { start, stop, reschedule, status, run, runNow: cb => run('вручную', cb) };


}

module.exports = { createHealthcheck, normalizeAutoPing, AUTOPING_DEFAULTS: DEFAULTS, AUTOPING_SCOPES: SCOPES };

