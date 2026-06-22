// ==UserScript==
// @name         DEX Runner (Distributed Execution POC)
// @namespace    golf-mafia
// @version      0.2.0
// @description  Thin distributed-execution runner. Registers this device, listens for commands over Supabase Realtime, runs reads AND a single-spot booking routine on the Dotgolf page, reports results back. Central brain (shell), distributed hands (this device).
// @match        https://www.remueragolfclub.com/Teebooking/*
// @match        https://www.golf.co.nz/Teebooking/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2
// @updateURL    https://dex-poc.netlify.app/de-runner.user.js
// @downloadURL  https://dex-poc.netlify.app/de-runner.user.js
// ==/UserScript==

/* eslint-disable no-var */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://albhfwnugnmrrzbhnzry.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_CWKfQyi9o-9Gph5H24QxAw_Gzv0ZZKi';
  var VERSION = 'v0.2.0';
  var HEARTBEAT_MS = 25000;
  var LS_DEVICE_ID = 'dex_device_id';
  var LS_DEVICE_LABEL = 'dex_device_label';
  var SS_ROUTINE = 'dex_routine_v1';
  var ROUTINE_TTL_MS = 180000; // a routine older than 3 min is abandoned

  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error('[DEX] supabase-js failed to load (@require). Aborting.');
    return;
  }
  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dex_auth' }
  });

  // ---- helpers --------------------------------------------------------------
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function nowISO() { return new Date().toISOString(); }
  function toMin(hhmm) { var m = /(\d{1,2}):(\d{2})/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function pageIsSlots() { return /SearchSlots\.aspx/i.test(location.pathname); }
  function pageIsConfirm() { return /ConfirmSlots\.aspx/i.test(location.pathname); }
  function highlight(td, color) { if (!td) return; td.style.outline = '4px solid ' + (color || '#e67e22'); td.style.outlineOffset = '-2px'; try { td.scrollIntoView({ block: 'center' }); } catch (e) {} }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); });
  }
  function deviceId() { var id = localStorage.getItem(LS_DEVICE_ID); if (!id) { id = uuid(); localStorage.setItem(LS_DEVICE_ID, id); } return id; }
  function deviceLabel() {
    var l = localStorage.getItem(LS_DEVICE_LABEL); if (l) return l;
    var ua = navigator.userAgent;
    return /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser';
  }

  var DEVICE_ID = deviceId();
  var session = null, channel = null, heartbeatTimer = null, routineResumed = false;

  // ===========================================================================
  // UI panel
  // ===========================================================================
  function buildPanel() {
    if ($('#dex-panel')) return;
    var p = document.createElement('div');
    p.id = 'dex-panel';
    p.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483600;width:280px;font:13px/1.4 system-ui,sans-serif;background:#fff;border:2px solid #2563eb;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);overflow:hidden';
    p.innerHTML =
      '<div style="background:#2563eb;color:#fff;padding:8px 10px;font-weight:700;display:flex;justify-content:space-between;align-items:center">' +
        '<span>DEX Runner <small style="opacity:.8">' + VERSION + '</small></span><span id="dex-min" style="cursor:pointer">–</span></div>' +
      '<div id="dex-body" style="padding:10px;max-height:70vh;overflow:auto">' +
        '<div id="dex-status" style="background:#333;color:#fff;padding:6px 8px;border-radius:6px;margin-bottom:8px">booting…</div>' +
        '<div id="dex-auth"></div>' +
        '<div id="dex-info" style="font-size:12px;opacity:.85;margin-top:6px"></div>' +
        '<div id="dex-last" style="font-size:12px;margin-top:8px;border-top:1px solid #eee;padding-top:6px;white-space:pre-wrap;word-break:break-word"></div>' +
      '</div>';
    document.body.appendChild(p);
    $('#dex-min').onclick = function () { var b = $('#dex-body'); var on = b.style.display === 'none'; b.style.display = on ? 'block' : 'none'; this.textContent = on ? '–' : '+'; };
  }
  function setStatus(msg, kind) {
    var el = $('#dex-status');
    if (el) { el.style.background = kind === 'error' ? '#c0392b' : kind === 'ok' ? '#1e7e34' : kind === 'work' ? '#b8860b' : '#333'; el.textContent = msg; }
    console.log('[DEX] ' + msg);
  }
  function setInfo() {
    var el = $('#dex-info'); if (!el) return;
    el.innerHTML = 'Device: <b>' + deviceLabel() + '</b><br>ID: <code style="font-size:11px">' + DEVICE_ID.slice(0, 8) + '…</code>' + (session ? '<br>User: ' + (session.user && session.user.email || session.user.id.slice(0, 8)) : '');
  }
  function showLast(text) { var el = $('#dex-last'); if (el) el.textContent = text; }

  function renderAuth() {
    var box = $('#dex-auth'); if (!box) return;
    if (session) {
      box.innerHTML = '<button id="dex-signout" style="width:100%;padding:6px;border:0;border-radius:6px;background:#eee;color:#333;font-size:12px">Sign out</button>' +
        '<label style="display:block;margin-top:6px;font-size:12px">Device label <input id="dex-label" value="' + deviceLabel() + '" style="width:100%;box-sizing:border-box"></label>';
      $('#dex-signout').onclick = function () { sb.auth.signOut().then(function () { location.reload(); }); };
      $('#dex-label').addEventListener('change', function () { localStorage.setItem(LS_DEVICE_LABEL, this.value || 'device'); setInfo(); registerDevice(); });
    } else {
      box.innerHTML =
        '<input id="dex-email" type="email" placeholder="email" style="width:100%;box-sizing:border-box;margin-bottom:4px">' +
        '<input id="dex-pass" type="password" placeholder="password" style="width:100%;box-sizing:border-box;margin-bottom:4px">' +
        '<button id="dex-signin" style="width:100%;padding:8px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:700">Sign in / up</button>' +
        '<div style="font-size:11px;opacity:.7;margin-top:4px">Same account as the shell.</div>';
      $('#dex-signin').onclick = doSignIn;
    }
  }
  function doSignIn() {
    var email = ($('#dex-email').value || '').trim(), pass = $('#dex-pass').value || '';
    if (!email || !pass) { setStatus('Enter email + password', 'error'); return; }
    setStatus('Signing in…', 'work');
    sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
      if (r.error) return sb.auth.signUp({ email: email, password: pass }).then(function (s) { if (s.error) throw s.error; return s; });
      return r;
    }).then(function () { return afterAuth(); }).catch(function (e) { setStatus('Auth failed: ' + (e.message || e), 'error'); });
  }

  // ===========================================================================
  // Presence
  // ===========================================================================
  function registerDevice() {
    if (!session) return Promise.resolve();
    return sb.from('de_devices').upsert({ id: DEVICE_ID, user_id: session.user.id, label: deviceLabel(), last_seen: nowISO(), online: true })
      .then(function (r) { if (r.error) console.warn('[DEX] device upsert', r.error); });
  }
  function heartbeat() { if (session) sb.from('de_devices').update({ last_seen: nowISO(), online: true }).eq('id', DEVICE_ID); }
  function goOffline() { if (session) { try { sb.from('de_devices').update({ online: false }).eq('id', DEVICE_ID); } catch (e) {} } }

  // ===========================================================================
  // Commands
  // ===========================================================================
  function subscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    channel = sb.channel('dex-' + DEVICE_ID)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'de_commands', filter: 'device_id=eq.' + DEVICE_ID }, function (p) { handleCommand(p.new); })
      .subscribe(function (st) { if (st === 'SUBSCRIBED') setStatus('Listening for commands…', 'ok'); });
  }
  function drainQueued() {
    if (!session) return;
    sb.from('de_commands').select('*').eq('device_id', DEVICE_ID).eq('status', 'queued').then(function (r) { if (!r.error) (r.data || []).forEach(handleCommand); });
  }

  function handleCommand(cmd) {
    if (!cmd || cmd.status !== 'queued') return;
    if (cmd.verb === 'makeBooking') { startBooking(cmd); return; }
    var t0 = performance.now();
    setStatus('Running: ' + cmd.verb, 'work');
    sb.from('de_commands').update({ status: 'running', claimed_at: nowISO() }).eq('id', cmd.id)
      .then(function () { return runVerb(cmd.verb, cmd.args || {}); })
      .then(function (result) {
        var ms = Math.round(performance.now() - t0); result = result || {}; result._ms = ms;
        return sb.from('de_commands').update({ status: 'done', result: result, completed_at: nowISO() }).eq('id', cmd.id)
          .then(function () { setStatus('Done: ' + cmd.verb + ' (' + ms + 'ms)', 'ok'); showLast(cmd.verb + ' → ' + JSON.stringify(result, null, 2)); });
      })
      .catch(function (e) {
        sb.from('de_commands').update({ status: 'error', error: String(e && e.message || e), completed_at: nowISO() }).eq('id', cmd.id);
        setStatus('Error: ' + cmd.verb + ' — ' + (e && e.message || e), 'error');
      });
  }

  function runVerb(verb, args) {
    switch (verb) {
      case 'ping': return Promise.resolve(verbPing());
      case 'readAvailability': return Promise.resolve(verbReadAvailability(args));
      case 'readFriends': return Promise.resolve(verbReadFriends());
      default: return Promise.reject(new Error('Unknown verb: ' + verb));
    }
  }
  function verbPing() {
    return { ok: true, url: location.href, title: document.title,
      page: pageIsSlots() ? 'slots' : pageIsConfirm() ? 'confirm' : /SearchClubDay\.aspx/i.test(location.pathname) ? 'daypicker' : 'other', ts: nowISO() };
  }
  function verbReadAvailability(args) {
    var table = $('table.slots_table');
    if (!table) return { ok: false, note: 'No slots table on this page. Open a day\'s tee sheet first.', url: location.href };
    var rows = [];
    $all('tbody tr', table).forEach(function (tr) {
      var cells = Array.prototype.slice.call(tr.children); if (cells.length < 3) return;
      var time = (cells[0].textContent || '').trim(), tee = (cells[1].textContent || '').trim();
      if (!/\d{1,2}:\d{2}/.test(time)) return;
      var eligible = $all('a.book_here_link', tr).length;
      var titles = {}; cells.slice(2).forEach(function (td) { var t = td.getAttribute('title'); if (t) titles[t] = 1; });
      rows.push({ time: time, tee: tee, freeEligibleSeats: eligible, categories: Object.keys(titles) });
    });
    var fm = toMin(args && args.from), tm = toMin(args && args.to);
    if (fm !== null || tm !== null) rows = rows.filter(function (r) { var t = toMin(r.time); return (fm === null || t >= fm) && (tm === null || t <= tm); });
    return { ok: true, count: rows.length, openTeeTimes: rows.filter(function (r) { return r.freeEligibleSeats > 0; }).length, rows: rows, url: location.href };
  }
  function verbReadFriends() {
    var best = null;
    $all('select[id$="_FriendCombo"]').forEach(function (fc) { if (fc.options && (!best || fc.options.length > best.options.length)) best = fc; });
    if (!best || !best.options || best.options.length <= 1) return { ok: false, note: 'No FriendCombo on this page.' };
    var list = Array.prototype.map.call(best.options, function (o) { return { id: o.value, name: (o.textContent || '').trim() }; }).filter(function (x) { return x.id; });
    return { ok: true, count: list.length, friends: list };
  }

  // ===========================================================================
  // BOOKING ROUTINE (makeBooking) — multi-page, survives reloads via sessionStorage.
  // Reuses the grabber's eligibility + flow. Single spot (no friends). Dry/Live.
  // ===========================================================================
  function loadRoutine() { try { return JSON.parse(sessionStorage.getItem(SS_ROUTINE) || 'null'); } catch (e) { return null; } }
  function saveRoutine(r) { try { sessionStorage.setItem(SS_ROUTINE, JSON.stringify(r)); } catch (e) {} }
  function clearRoutine() { try { sessionStorage.removeItem(SS_ROUTINE); } catch (e) {} }
  function reportStage(cmdId, stage) { if (session) sb.from('de_commands').update({ status: 'running', result: { stage: stage } }).eq('id', cmdId); setStatus(stage, 'work'); }
  function finishRoutine(r, status, payload, errMsg) {
    var upd = { status: status, completed_at: nowISO() };
    if (status === 'done') upd.result = payload; if (status === 'error') upd.error = errMsg || 'Booking failed';
    if (session) sb.from('de_commands').update(upd).eq('id', r.cmdId);
    clearRoutine();
    setStatus(status === 'done' ? 'Routine done' : 'Routine error', status === 'done' ? 'ok' : 'error');
    showLast('makeBooking → ' + (status === 'done' ? JSON.stringify(payload) : errMsg));
  }
  function searchSlotsUrl(dateISO) { return location.origin + '/Teebooking/SearchSlots.aspx?ClubId=361&CourseId=null&Date=' + dateISO; }
  function onDate(r) { return pageIsSlots() && location.search.indexOf('Date=' + r.args.date) !== -1; }

  var BK_RANK = ['18 Hole Men Home Members Only', '18 Hole Men/Women Home Members Only', 'Open to ALL Home Members', 'Open to ALL'];
  function bkRank(t) { var i = BK_RANK.indexOf(t); return i === -1 ? 999 : i; }
  function bkHolesOk(args, title) {
    if (args.holes === 'any') return true;
    if (args.holes === '9') return /\b9H\b|9\s*Hole/i.test(title);
    if (args.holes === '18') return /18\s*Hole/i.test(title) && !/9H/i.test(title);
    return true;
  }
  function bkFindFirst(args) {
    var table = $('table.slots_table'); if (!table) return null;
    var fromM = toMin(args.from), toM = toMin(args.to), out = [];
    $all('tbody tr', table).forEach(function (tr) {
      var cells = Array.prototype.slice.call(tr.children); if (cells.length < 3) return;
      var timeTxt = (cells[0].textContent || '').trim(), teeTxt = (cells[1].textContent || '').trim();
      var tMin = toMin(timeTxt); if (tMin === null) return;
      if (fromM !== null && tMin < fromM) return;
      if (toM !== null && tMin > toM) return;
      if (args.tee !== 'any' && teeTxt !== args.tee) return;
      cells.slice(2).forEach(function (td) {
        var link = td.querySelector('a.book_here_link'); if (!link) return;       // eligibility gate
        var title = td.getAttribute('title') || '';
        if (!bkHolesOk(args, title)) return;
        out.push({ time: timeTxt, tee: teeTxt, title: title, link: link, td: td, rank: [bkRank(title), tMin] });
      });
    });
    out.sort(function (a, b) { return a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]; });
    return out[0] || null;
  }

  function startBooking(cmd) {
    var r = { cmdId: cmd.id, args: cmd.args || {}, stage: 'navigating', startedAt: Date.now() };
    saveRoutine(r);
    setStatus('Opening the tee sheet…', 'work');
    sb.from('de_commands').update({ status: 'running', claimed_at: nowISO(), result: { stage: 'Opening the tee sheet…' } }).eq('id', cmd.id)
      .then(function () { location.href = searchSlotsUrl(r.args.date); });
  }

  function resumeRoutine() {
    var r = loadRoutine(); if (!r) return;
    if (Date.now() - (r.startedAt || 0) > ROUTINE_TTL_MS) { finishRoutine(r, 'error', null, 'Routine timed out.'); return; }

    // Page 1 — the slot sheet
    if (onDate(r)) {
      reportStage(r.cmdId, 'Reading the sheet…');
      var best = bkFindFirst(r.args);
      if (!best) { finishRoutine(r, 'error', null, 'No eligible slot in your window on this sheet.'); return; }
      highlight(best.td, r.args.mode === 'live' ? '#27ae60' : '#e67e22');
      if (r.args.mode !== 'live') { finishRoutine(r, 'done', { dry: true, time: best.time, tee: best.tee, categories: [best.title] }); return; }
      r.stage = 'reserving'; r.chosen = { time: best.time, tee: best.tee, title: best.title }; saveRoutine(r);
      reportStage(r.cmdId, 'Reserving ' + best.time + ' Tee ' + best.tee + '…');
      best.link.click(); // → ConfirmSlots (mints reCAPTCHA via the page's own handler)
      return;
    }
    // Page 2 — player details / confirm
    if (pageIsConfirm()) {
      if (r.stage === 'reserving' || r.stage === 'confirming') {
        reportStage(r.cmdId, 'Filling your booking…');
        var em = $('input[name$="cbSendEmailNotifications"]');
        if (em && em.checked) { em.checked = false; em.dispatchEvent(new Event('change', { bubbles: true })); }
        r.stage = 'submitting'; saveRoutine(r);
        reportStage(r.cmdId, 'Submitting…');
        var submit = $('input[name$="ContinueButton"]');
        if (submit) submit.click(); else finishRoutine(r, 'error', null, 'Submit button not found.');
      } else if (r.stage === 'submitting') {
        finishRoutine(r, 'error', null, 'Booking did not complete (back on player details — likely a booking limit). Finish manually if needed.');
      }
      return;
    }
    // Page 3 — payment / finalise
    var fin = $all('a,button,input[type=submit],input[type=button]').filter(function (e) { return /finalis(e|ing)?\s*booking|finalize booking/i.test(e.textContent || e.value || ''); })[0];
    if (fin && (r.stage === 'submitting' || r.stage === 'finalising')) {
      r.stage = 'finalising'; saveRoutine(r);
      reportStage(r.cmdId, 'Finalising…');
      fin.click();
      return;
    }
    // Confirmation — submitted/finalised and no longer on confirm/payment
    if (r.stage === 'submitting' || r.stage === 'finalising') {
      var ch = r.chosen || {};
      finishRoutine(r, 'done', { booked: true, time: ch.time, tee: ch.tee, note: 'Booked a single spot.' });
    }
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  function afterAuth() {
    renderAuth(); setInfo();
    return registerDevice().then(function () {
      subscribe(); drainQueued();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
      setStatus('Online — ready.', 'ok');
      if (!routineResumed) { routineResumed = true; try { resumeRoutine(); } catch (e) { console.error('[DEX] resume', e); } }
    });
  }
  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    buildPanel(); setStatus('Checking session…', 'work');
    sb.auth.getSession().then(function (r) {
      session = r.data && r.data.session || null;
      if (session) afterAuth(); else { renderAuth(); setInfo(); setStatus('Sign in to register this device.', 'idle'); }
    });
    sb.auth.onAuthStateChange(function (_e, s) { session = s; setInfo(); if (session) afterAuth(); else renderAuth(); });
    window.addEventListener('pagehide', goOffline);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && session) { heartbeat(); drainQueued(); } });
  }
  boot();
})();
