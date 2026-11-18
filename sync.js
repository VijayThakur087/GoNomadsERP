/* =====================================================================
   Go Nomads ERP – Cloud Sync (Supabase, free plan)
   Put this file next to index.html. No other code changes are needed
   except: (1) CSP line  (2) two <script> tags  (3) the two values below.
   ===================================================================== */
(function () {
  'use strict';

  /* ---- 1. PASTE YOUR TWO VALUES HERE (Supabase > Project Settings > API) ---- */
  var SB_URL = 'https://mxrlpkekvbwhrmtrvqfh.supabase.co';
  var SB_KEY = 'sb_publishable_HoPhJBN0RAacwJb7IjsEZg_nILB13qE';  // the "anon public" key (NOT service_role)
  /* --------------------------------------------------------------------------- */

  if (SB_URL.indexOf('PASTE') === 0 || !window.supabase) { console.warn('Cloud sync is not configured.'); return; }

  var KINDS = ['invoices', 'costings', 'payables', 'customers', 'vendors', 'ledger'];
  var SKIP_SETTINGS = ['pin', 'lastBackup'];           // these stay on each device only
  var sb, user = null, snap = {}, lastPull = '', busy = false, again = false, paused = false;
  var pushTimer = null, chan = null, started = false;

  /* ---------- small helpers ---------- */
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function h53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function hash(o) { return h53(stable(o)); }

  function badge(s) {
    var b = document.getElementById('sync-badge');
    if (!b) {
      b = document.createElement('div'); b.id = 'sync-badge';
      b.style.cssText = 'position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:99998;background:#0f172a;color:#fff;font:600 12px system-ui,sans-serif;padding:6px 10px;border-radius:999px;opacity:.92;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      b.onclick = function () { if (!user) askLogin(); else { paused = false; runSync(true); } };
      document.body.appendChild(b);
    }
    var t = { ok: '🟢 Synced', busy: '🟡 Syncing…', off: '🔴 Offline – saved on this device', login: '🔒 Tap to log in', pause: '⏸ Sync paused – tap to resume', err: '🟠 Sync problem – tap to retry' };
    b.textContent = t[s] || s;
  }

  function askLogin() {
    if (document.getElementById('sync-login')) return;
    var d = document.createElement('div'); d.id = 'sync-login';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.85);display:flex;align-items:center;justify-content:center;padding:16px';
    var inp = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:10px;margin-bottom:8px;font-size:16px';
    d.innerHTML = '<div style="background:#fff;border-radius:16px;padding:20px;width:100%;max-width:340px;font-family:system-ui,sans-serif">' +
      '<h3 style="margin:0 0 4px;font-size:18px">Cloud sync login</h3>' +
      '<p style="margin:0 0 12px;font-size:12px;color:#64748b">Use the same email and password on all your devices.</p>' +
      '<input id="sl-email" type="email" placeholder="Email" autocomplete="username" style="' + inp + '">' +
      '<input id="sl-pass" type="password" placeholder="Password" autocomplete="current-password" style="' + inp + '">' +
      '<p id="sl-err" style="color:#e11d48;font-size:12px;min-height:16px;margin:0 0 8px"></p>' +
      '<button id="sl-go" style="width:100%;padding:11px;border:0;border-radius:10px;background:#0f172a;color:#fff;font-weight:600;font-size:15px">Log in</button>' +
      '<button id="sl-skip" style="width:100%;padding:9px;border:0;background:none;color:#64748b;font-size:13px;margin-top:6px">Skip – work on this device only</button></div>';
    document.body.appendChild(d);
    document.getElementById('sl-skip').onclick = function () { d.remove(); badge('login'); };
    document.getElementById('sl-go').onclick = async function () {
      var err = document.getElementById('sl-err'); err.textContent = '';
      try {
        var r = await sb.auth.signInWithPassword({ email: document.getElementById('sl-email').value.trim(), password: document.getElementById('sl-pass').value });
        if (r.error) { err.textContent = r.error.message; return; }
        user = r.data.user; d.remove(); boot();
      } catch (e) { err.textContent = 'Could not connect. Check internet.'; }
    };
  }

  /* ---------- what is on this device right now ---------- */
  function cleanSettings() {
    var s = Object.assign({}, appState.settings); SKIP_SETTINGS.forEach(function (k) { delete s[k]; }); return s;
  }
  function localRecords() {
    var m = {};
    KINDS.forEach(function (k) {
      (appState[k] || []).forEach(function (r) { if (r && r.id != null) m[k + '|' + r.id] = { kind: k, id: String(r.id), data: r }; });
    });
    m['fin|fin'] = { kind: 'fin', id: 'fin', data: appState.fin || {} };
    m['settings|settings'] = { kind: 'settings', id: 'settings', data: cleanSettings() };
    return m;
  }

  /* ---------- remember what the cloud already has ---------- */
  async function saveSnap() { await IDB.set('sync_snap', JSON.stringify(snap)); await IDB.set('sync_last', lastPull); }
  async function loadSnap() {
    try { snap = JSON.parse((await IDB.get('sync_snap')) || '{}'); } catch (e) { snap = {}; }
    lastPull = (await IDB.get('sync_last')) || '';
  }

  /* ---------- cloud -> this device ---------- */
  function put(r) {
    if (KINDS.indexOf(r.kind) >= 0) {
      var a = appState[r.kind], i = a.findIndex(function (x) { return String(x.id) === r.id; });
      if (i >= 0) a[i] = r.data; else a.unshift(r.data);
    } else if (r.kind === 'fin') appState.fin = r.data || {};
    else if (r.kind === 'settings') Object.assign(appState.settings, r.data || {});
  }
  function removeLocal(kind, id) {
    if (KINDS.indexOf(kind) >= 0) appState[kind] = appState[kind].filter(function (x) { return String(x.id) !== id; });
  }
  function refreshUI() {
    try {
      var tab = document.querySelector('section[id^="tab-"]:not(.hidden)');
      var modal = document.querySelector('.fixed.inset-0.z-50:not(.hidden)');
      persistData();
      if (tab && !modal) switchTab(tab.id.replace('tab-', ''));
    } catch (e) { console.warn(e); }
  }
  function applyRows(rows) {
    if (!rows || !rows.length) return;
    var cur = localRecords(), changed = false;
    rows.forEach(function (r) {
      var k = r.kind + '|' + r.id, c = cur[k];
      // I edited this record on this device and it is not sent yet -> keep mine
      if (c && snap[k] !== undefined && hash(c.data) !== snap[k]) return;
      // I deleted this record on this device and the delete is not sent yet -> do not bring it back
      if (!c && snap[k] !== undefined && !r.deleted && hash(r.data) === snap[k]) return;
      if (r.deleted) { if (c) { removeLocal(r.kind, r.id); changed = true; } delete snap[k]; return; }
      put(r);
      snap[k] = (r.kind === 'settings') ? hash(cleanSettings()) : hash(r.data);
      changed = true;
    });
    if (changed) refreshUI();
    saveSnap();
  }
  async function pull() {
    for (var guard = 0; guard < 50; guard++) {
      var q = sb.from('records').select('*').order('updated_at', { ascending: true }).limit(1000);
      if (lastPull) q = q.gte('updated_at', lastPull);
      var res = await q; if (res.error) throw res.error;
      var rows = res.data || []; applyRows(rows);
      if (!rows.length) break;
      var newest = rows[rows.length - 1].updated_at;
      var more = rows.length === 1000 && newest !== lastPull;
      lastPull = newest; await saveSnap();
      if (!more) break;
    }
  }

  /* ---------- this device -> cloud ---------- */
  async function push() {
    var cur = localRecords(), up = [], marks = [];
    Object.keys(cur).forEach(function (k) {
      var h = hash(cur[k].data);
      if (snap[k] !== h) { up.push({ owner: user.id, kind: cur[k].kind, id: cur[k].id, data: cur[k].data, deleted: false }); marks.push([k, h]); }
    });
    var gone = Object.keys(snap).filter(function (k) { return !cur[k]; });
    if (gone.length > 10 && gone.length > Object.keys(snap).length / 2) {
      if (!confirm('This device is missing ' + gone.length + ' records that are in the cloud.\n\nDelete them from the cloud and from all devices too?')) { paused = true; return; }
    }
    gone.forEach(function (k) {
      var p = k.split('|'); up.push({ owner: user.id, kind: p[0], id: p.slice(1).join('|'), data: null, deleted: true }); marks.push([k, null]);
    });
    for (var i = 0; i < up.length; i += 200) {
      var r = await sb.from('records').upsert(up.slice(i, i + 200), { onConflict: 'owner,kind,id' });
      if (r.error) throw r.error;
      marks.slice(i, i + 200).forEach(function (m) { if (m[1] === null) delete snap[m[0]]; else snap[m[0]] = m[1]; });
      await saveSnap();
    }
  }

  async function runSync(manual) {
    if (!user || paused || window.__noSave) { if (paused) badge('pause'); return; }
    if (!navigator.onLine) { badge('off'); return; }
    if (busy) { again = true; return; }
    busy = true; badge('busy');
    try { await pull(); await push(); badge(paused ? 'pause' : 'ok'); }
    catch (e) { console.warn('sync', e); badge('err'); if (manual && typeof showToast === 'function') showToast('Sync problem', String((e && e.message) || e)); }
    finally { busy = false; if (again) { again = false; setTimeout(runSync, 500); } }
  }
  function schedulePush() {
    if (!user) return;
    if (!navigator.onLine) { badge('off'); return; }
    clearTimeout(pushTimer); pushTimer = setTimeout(function () { runSync(); }, 1500);
  }

  function listen() {
    if (chan) return;
    chan = sb.channel('gn-records').on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, function (p) {
      if (p.new && p.new.kind) applyRows([p.new]);
    }).subscribe();
  }
  async function boot() {
    if (localStorage.getItem('gn_sync_uid') !== user.id) { snap = {}; lastPull = ''; localStorage.setItem('gn_sync_uid', user.id); await saveSnap(); }
    listen(); await runSync();
  }

  async function start() {
    if (started) return; started = true;
    sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    await loadSnap();
    var sess = null;
    try { var r = await sb.auth.getSession(); sess = r.data && r.data.session; } catch (e) {}
    if (sess) { user = sess.user; boot(); }
    else if (!navigator.onLine && localStorage.getItem('gn_sync_uid')) badge('off');
    else { badge('login'); askLogin(); }

    window.addEventListener('online', async function () {
      if (user) return runSync();
      try { var r = await sb.auth.getSession(); if (r.data && r.data.session) { user = r.data.session.user; boot(); } else { badge('login'); askLogin(); } } catch (e) {}
    });
    window.addEventListener('offline', function () { badge('off'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') runSync(); });
    setInterval(function () { if (document.visibilityState === 'visible') runSync(); }, 45000);
    sb.auth.onAuthStateChange(function (ev, s) { if (ev === 'SIGNED_OUT') { user = null; badge('login'); } else if (s && s.user) user = s.user; });
  }

  /* ---------- plug into the existing app (no edits needed in index.html) ---------- */
  var _init = initApp; initApp = function () { _init.apply(this, arguments); setTimeout(start, 300); };
  var _persist = persistData; persistData = function () { var r = _persist.apply(this, arguments); schedulePush(); return r; };
})();
