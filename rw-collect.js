/* ห้องสมุดนิยาย — ReadAWrite suggestion collector (💡 แนะนำ tab).

   Runs inside a readawrite.com tab, started from the "💡 อัปเดตนิยายแนะนำ"
   bookmarklet (or pasted into DevTools › Console). The app wraps this file
   with window.__NV = { u: <Apps Script URL>, t: <secret> }.

   It calls ReadAWrite's own list API from your verified browser session (it
   never bypasses or automates the "ยืนยันตัวตน" check), builds the 3 BL
   lists, merges them with the list + marks saved in your Google Sheet
   (marked novels are dropped, unmarked ones stay, new ones fill the empty
   slots up to 20), fetches synopses for the newly added novels, and saves
   the result back to the Sheet. ReadAWrite blocks connections to Google
   from its pages, so normally it hands the data to the app in a new tab
   (postMessage) and the app saves it; downloading a JSON file to upload
   in the app is the last-resort fallback.

   Written with block comments and explicit semicolons only, so it still
   runs if a browser strips newlines from the bookmarklet. */
(async function () {
  var CFG = window.__NV || {};
  var LIMIT = 20;
  var CATS = [32, 55, 54];
  var CAT_SHORT = { 32: 'Lovely Room', 55: 'Party Room', 54: 'Secret Room' };
  var DRAMA = /ดราม่า|ดรามา/;
  var RE_THAI = /พีเรียดไทย|ย้อนยุคไทย|ไทยย้อนยุค/;
  var T2_SPECS = [{ g: ['11'] }, { g: ['1158'] }, { t: ['1324084'] }, { g: ['5995'] }, { g: ['11', '5995'] }];
  var T3_SPECS = [{ g: ['6017'] }, { t: ['1324082'] }, { t: ['7690'] }];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---- on-page progress panel ---- */
  var old = document.getElementById('nv-collect-box');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = 'nv-collect-box';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-width:calc(100vw - 32px);max-height:60vh;overflow:auto;background:#16211c;color:#e6f0ea;border:1px solid #3fb98f;border-radius:14px;padding:14px 16px;font:14px/1.55 Sarabun,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45);text-align:left;';
  box.innerHTML = '<div style="font-weight:700;color:#6fd3ad;margin-bottom:6px;">💡 อัปเดตนิยายแนะนำ</div><div id="nv-log"></div><div id="nv-prog" style="color:#9db3aa;"></div><button id="nv-close" style="margin-top:10px;background:none;border:1px solid #38493f;color:#9db3aa;border-radius:8px;padding:4px 12px;cursor:pointer;font:inherit;">ปิด</button>';
  document.body.appendChild(box);
  box.querySelector('#nv-close').onclick = function () { box.remove(); };
  var logEl = box.querySelector('#nv-log');
  var progEl = box.querySelector('#nv-prog');
  function log(msg, color) {
    console.log('[นิยายแนะนำ] ' + msg);
    var d = document.createElement('div');
    d.textContent = msg;
    if (color) d.style.color = color;
    logEl.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
  function progress(msg) { progEl.textContent = msg ? '⏳ ' + msg : ''; }

  if (!/(^|\.)readawrite\.com$/.test(location.hostname)) {
    log('⚠️ เปิดหน้าเว็บ readawrite.com ก่อน แล้วกดบุ๊กมาร์กนี้อีกครั้ง', '#f0a94d');
    return;
  }

  /* ---- ReadAWrite API (same-origin, jQuery-style key[] arrays, empty arrays omitted) ---- */
  async function api(data, field) {
    var body = new URLSearchParams();
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (Array.isArray(v)) v.forEach(function (x) { body.append(k + '[]', x); });
      else body.append(k, v);
    });
    var res = await fetch('/?action=ajax&ajax=1&ajax_case=CallWrapper', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: body.toString()
    });
    var text = await res.text();
    var j;
    try { j = JSON.parse(text); }
    catch (e) {
      var err = new Error('ReadAWrite ไม่ได้ตอบเป็นข้อมูล — ถ้าขึ้นหน้า "ยืนยันตัวตน" ให้รีเฟรชหน้า กดยืนยันเอง แล้วกดบุ๊กมาร์กอีกครั้ง');
      err.fatal = true;
      throw err;
    }
    if (!j || !j.status || !j.status.success) throw new Error((j && j.status && j.status.message) || 'API ไม่สำเร็จ');
    return (j.data && j.data[field || 'article_list']) || [];
  }

  /* ---- text helpers ---- */
  var ta = document.createElement('textarea');
  function decode(s) { ta.innerHTML = String(s == null ? '' : s); return ta.value; }
  function clean(s) { return decode(s).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim(); }
  function cleanSyn(s) {
    var t = clean(s).replace(/&[a-z#0-9]*$/i, '').trim();
    if (t.length <= 2) return '';
    if (t.length >= 95) t = t.replace(/[.…]+$/, '') + '…';
    return t;
  }
  function normName(s) {
    return String(s || '').toLowerCase()
      .replace(/[\(\[\{（【「『<][^\)\]\}）】」』>]*[\)\]\}）】」』>]/g, '')
      .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  }

  function norm(a) {
    var lg = String(a.article_guid || '');
    var sg = String(a.article_short_guid || '');
    var path = a.article_thumbnail_path ? String(a.article_thumbnail_path) : '';
    return {
      guid: lg || sg,
      uid: sg || lg,
      name: clean(a.article_name),
      author: clean(a.author_name),
      catId: parseInt(a.category_id_v2, 10) || 0,
      ch: parseInt(a.chapter_count, 10) || 0,
      views: parseInt(a.view_count, 10) || 0,
      hearts: parseInt(a.rating_count, 10) || 0,
      end: String(a.is_end) === '1' ? 1 : 0,
      thumb: path ? path + 'large.gif?web_' + (a.thumbnail_edition || '') : '',
      allTags: (a.tag_list || []).map(function (t) { return clean(t && t.tag_name); }).filter(Boolean)
    };
  }

  function okBase(it) {
    return !!it.guid && CATS.indexOf(it.catId) >= 0 && !it.allTags.some(function (t) { return DRAMA.test(t); });
  }
  var RULES = {
    t1: function (it) { return okBase(it) && it.allTags.some(function (t) { return t.indexOf('แก้แค้น') >= 0; }); },
    t2: function (it) {
      return okBase(it) &&
        it.allTags.some(function (t) { return t.indexOf('จีนโบราณ') >= 0; }) &&
        it.allTags.some(function (t) { return t.indexOf('เกิดใหม่') >= 0; });
    },
    t3: function (it) { return okBase(it) && it.allTags.some(function (t) { return RE_THAI.test(t); }); }
  };

  function pickTags(it, tab) {
    var all = it.allTags;
    var hl = [];
    if (tab === 't1') {
      var r = all.find(function (t) { return t.indexOf('แก้แค้น') >= 0; });
      if (r) hl.push(r);
    } else if (tab === 't2') {
      var a = all.find(function (t) { return t.indexOf('จีนโบราณ') >= 0; });
      var b = all.find(function (t) { return t.indexOf('เกิดใหม่') >= 0; });
      if (a) hl.push(a);
      if (b && b !== a) hl.push(b);
    } else if (tab === 't3') {
      var c = all.find(function (t) { return RE_THAI.test(t); });
      if (c) hl.push(c);
      if (all.indexOf('ย้อนยุค') >= 0 && hl.indexOf('ย้อนยุค') < 0) hl.push('ย้อนยุค');
    }
    var skip = tab === 't1' ? /แก้แค้น/ : (tab === 't2' ? /จีนโบราณ|เกิดใหม่/ : (tab === 't3' ? /พีเรียดไทย|ย้อนยุคไทย|ไทยย้อนยุค|ย้อนยุค/ : null));
    var seen = {};
    hl.forEach(function (t) { seen[t] = 1; });
    var other = [];
    for (var i = 0; i < all.length; i++) {
      var t = all[i];
      if (hl.length + other.length >= 7) break;
      if (seen[t] || t.charAt(0) === '#' || t.length > 28) continue;
      if (skip && skip.test(t)) continue;
      seen[t] = 1;
      other.push(t);
    }
    return { hl: hl, tags: other };
  }

  function buildPool(raw, tab) {
    var map = {};
    raw.map(norm).forEach(function (it) {
      if (!RULES[tab](it)) return;
      var prev = map[it.guid];
      if (!prev || it.views > prev.views) map[it.guid] = it;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.views - a.views; })
      .map(function (it) {
        var t = pickTags(it, tab);
        return {
          tab: tab, guid: it.guid, uid: it.uid, name: it.name, author: it.author,
          cat: CAT_SHORT[it.catId] || '', ch: it.ch, views: it.views, hearts: it.hearts,
          end: it.end, thumb: it.thumb, tags: t.tags, hl: t.hl, syn: '', is_new: 0
        };
      });
  }

  /* ---- fetching ---- */
  async function safeApi(label, data, field) {
    try { return await api(data, field); }
    catch (e) {
      if (e.fatal) throw e;
      log('⚠️ ' + label + ': ' + e.message, '#f0a94d');
      return null;
    }
  }

  /* List ①: novels TAGGED แก้แค้น. Look up every tag whose name contains
     แก้แค้น (tag search), list each one per BL category, and add a search by
     tag name for extra coverage. The strict tag rule is applied afterwards. */
  async function fetchT1() {
    progress('① ค้นหาแท็ก "แก้แค้น"');
    var found = await safeApi('ค้นหาแท็ก แก้แค้น', {
      api_call: 'Search', method_call: 'userSearchTagNameAutoCompleteBySearchService',
      app_id: 'RAW', app_platform: 'WEB', tag_name: 'แก้แค้น',
      sort_by: 'article_count', sort_type: 'desc', result_per_page: 20, page_no: 1
    }, 'tag_list') || [];
    var specs = [];
    var seen = {};
    found.forEach(function (t) {
      if (clean(t && t.tag_name).indexOf('แก้แค้น') < 0) return;
      var id = String(t.tag_id || '');
      var g = String(t.tag_group_id || '');
      if (id && !seen['t' + id]) { seen['t' + id] = 1; specs.push({ t: [id] }); }
      if (g && g !== '0' && !seen['g' + g]) { seen['g' + g] = 1; specs.push({ g: [g] }); }
    });
    specs = specs.slice(0, 10);
    log('① พบแท็กที่มีคำว่า "แก้แค้น" ' + found.filter(function (t) { return clean(t && t.tag_name).indexOf('แก้แค้น') >= 0; }).length + ' แท็ก');
    var out = specs.length ? await fetchTagLists('① แท็ก แก้แค้น', specs) : [];
    for (var p = 1; p <= 12; p++) {
      progress('① ค้นหาด้วยแท็ก "แก้แค้น" หน้า ' + p);
      var list = await safeApi('ค้นหาด้วยแท็ก หน้า ' + p, {
        api_call: 'Search', method_call: 'userSearchArticlesBySearchService', token: '',
        article_name: '', author_name: '', article_synopsis: '', publisher_name: '', category_name: '',
        article_species: 'ALL', article_type: 'ALL', category_id_2: '', tag_name: 'แก้แค้น',
        is_end: '', is_yourname: '', is_fanfiction: 0,
        excluded_article_species: ['CARTOON', 'TOPIC', 'CHAT'],
        sort_by: 'view_count', sort_type: 'DESC', app_id: 'RAW', app_platform: 'WEB',
        result_per_page: 50, more_than_one_chapter: 0, is_user_verified: 0, required_verify: 1,
        exact_search: 0, page_no: p
      });
      if (!list) break;
      out = out.concat(list);
      if (list.length < 50) break;
      await sleep(250);
    }
    return out;
  }

  async function fetchTagLists(label, specs) {
    var out = [];
    for (var c = 0; c < CATS.length; c++) {
      for (var s = 0; s < specs.length; s++) {
        for (var p = 1; p <= 5; p++) {
          progress(label + ' · หมวด ' + CATS[c] + ' · ชุด ' + (s + 1) + '/' + specs.length + ' · หน้า ' + p);
          var list = await safeApi(label + ' หมวด ' + CATS[c], {
            api_call: 'Article', method_call: 'userListArticle',
            article_species: '', article_type: '', category_id: CATS[c], category_version: 2,
            is_end: '', is_yourname: '', is_fanfiction: '', page_cache: '',
            tag_group_id_list: specs[s].g || [], tag_id_list: specs[s].t || [],
            result_per_page: 50, is_user_verified: 0, required_verify: 1,
            page_no: p, sort_by: 'view_count'
          });
          if (!list) break;
          out = out.concat(list);
          if (list.length < 50) break;
          await sleep(200);
        }
      }
    }
    return out;
  }

  async function fetchSyn(items) {
    var need = items.filter(function (x) { return !x.syn; });
    for (var i = 0; i < need.length; i += 5) {
      progress('📝 ดึงเรื่องย่อ ' + Math.min(i + 5, need.length) + '/' + need.length);
      await Promise.all(need.slice(i, i + 5).map(async function (x) {
        try {
          var r = await fetch('/a/' + encodeURIComponent(x.uid || x.guid), { credentials: 'same-origin' });
          var html = await r.text();
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var m = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
          x.syn = cleanSyn(m ? m.getAttribute('content') : '');
        } catch (e) { x.syn = ''; }
      }));
      await sleep(400);
    }
  }

  /* ---- merge with saved list + marks (same rules as the app) ---- */
  function fromRow(o) {
    return {
      tab: String(o.tab || ''), guid: String(o.guid || ''), uid: String(o.uid || ''),
      name: String(o.name || ''), author: String(o.author || ''), cat: String(o.cat || ''),
      ch: parseInt(o.ch, 10) || 0, views: parseInt(o.views, 10) || 0, hearts: parseInt(o.hearts, 10) || 0,
      end: String(o.end) === '1' ? 1 : 0, thumb: String(o.thumb || ''),
      tags: Array.isArray(o.tags) ? o.tags : String(o.tags || '').split('|').filter(Boolean),
      hl: Array.isArray(o.hl) ? o.hl : String(o.hl || '').split('|').filter(Boolean),
      syn: String(o.syn || ''), is_new: String(o.is_new) === '1' ? 1 : 0
    };
  }
  function toRow(x) {
    var o = Object.assign({}, x);
    o.tags = (x.tags || []).join('|');
    o.hl = (x.hl || []).join('|');
    return o;
  }
  function markMap(marks) {
    var m = {};
    (marks || []).forEach(function (r) {
      if (!r || !r.mark) return;
      if (r.guid) m[String(r.guid)] = r.mark;
      if (r.uid) m[String(r.uid)] = r.mark;
      var n = normName(r.name);
      if (n) m['n:' + n] = r.mark;
    });
    return m;
  }
  function markOf(m, x) {
    return m[String(x.guid)] || (x.uid && m[String(x.uid)]) || m['n:' + normName(x.name)] || '';
  }
  /* List ① used to match titles; old title-only entries (no แก้แค้น tag) don't carry over. */
  function stillFits(tab, x) {
    return tab !== 't1' || (x.hl || []).some(function (t) { return t.indexOf('แก้แค้น') >= 0; });
  }
  function merge(current, pools, marks) {
    var mk = markMap(marks);
    var hadPrev = current.length > 0;
    var out = [];
    var added = 0;
    ['t1', 't2', 't3'].forEach(function (tab) {
      var pool = pools[tab] || [];
      var byGuid = {};
      pool.forEach(function (x) { byGuid[x.guid] = x; });
      var keep = [];
      var have = {};
      current.filter(function (x) { return x.tab === tab && !markOf(mk, x) && (byGuid[x.guid] || stillFits(tab, x)); }).forEach(function (x) {
        if (have[x.guid]) return;
        var fresh = byGuid[x.guid];
        var item = fresh ? Object.assign({}, fresh, { syn: x.syn || fresh.syn || '', is_new: 0 }) : Object.assign({}, x, { is_new: 0 });
        have[x.guid] = 1;
        keep.push(item);
      });
      for (var i = 0; i < pool.length && keep.length < LIMIT; i++) {
        var c = pool[i];
        if (have[c.guid] || markOf(mk, c)) continue;
        have[c.guid] = 1;
        keep.push(Object.assign({}, c, { is_new: hadPrev ? 1 : 0 }));
        if (hadPrev) added++;
      }
      keep.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
      out = out.concat(keep);
    });
    return { list: out, added: added };
  }

  async function gas(payload) {
    payload.token = CFG.t;
    var res = await fetch(CFG.u, { method: 'POST', body: JSON.stringify(payload) });
    var j = await res.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'Google Sheet ตอบกลับผิดพลาด');
    return j;
  }

  function btn(label, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;cursor:pointer;border-radius:9px;padding:7px 14px;' +
      (primary ? 'background:#3fb98f;color:#0f1613;border:none;font-weight:700;' : 'background:none;color:#9db3aa;border:1px solid #38493f;');
    return b;
  }

  /* Fallback 1: download the pool as a file to upload in the app. */
  async function downloadPools(pools) {
    var trimmed = { t1: pools.t1.slice(0, 60), t2: pools.t2.slice(0, 60), t3: pools.t3.slice(0, 60) };
    await fetchSyn([].concat(trimmed.t1.slice(0, 25), trimmed.t2.slice(0, 25), trimmed.t3.slice(0, 25)));
    progress('');
    var day = new Date().toISOString().slice(0, 10);
    download({ kind: 'novel-suggest-pool', generated_at: new Date().toISOString(), pools: trimmed }, 'novel-suggest_' + day + '.json');
    log('📥 ดาวน์โหลดไฟล์แล้ว → เปิดแอป › 💡 แนะนำ › 🔄 อัปเดตรายการ › อัปโหลดไฟล์', '#6fd3ad');
  }

  /* Handoff: ReadAWrite's security policy blocks connections to Google from
     its pages, so open the app in a new tab and pass the data with
     postMessage (not affected by that policy). The app loads the saved list +
     marks and sends them here; this tab merges, fetches synopses for the new
     novels (only possible on readawrite.com) and sends the final list back
     for the app to save. */
  function offerHandoff(pools) {
    var appUrl = (CFG.a || 'https://parepiy.github.io/novel/').split('#')[0];
    var appOrigin = new URL(appUrl, location.href).origin;
    log('เก็บข้อมูลเสร็จแล้ว — กด “ส่งเข้าแอป” เพื่อบันทึก', '#6fd3ad');
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 2px;';
    var send = btn('📤 ส่งเข้าแอป', true);
    var dl = btn('📥 ดาวน์โหลดไฟล์แทน', false);
    row.appendChild(send);
    row.appendChild(dl);
    logEl.appendChild(row);
    dl.onclick = function () { dl.disabled = true; downloadPools(pools); };
    send.onclick = function () {
      var working = false;
      function onMsg(ev) {
        if (ev.origin !== appOrigin || !ev.data || typeof ev.data !== 'object') return;
        var m = ev.data;
        var reply = function (msg) { ev.source.postMessage(msg, appOrigin); };
        if (m.type === 'nv-ready') {
          reply({ type: 'nv-hello', u: CFG.u || '', t: CFG.t || '' });
        } else if (m.type === 'nv-state' && !working) {
          working = true;
          (async function () {
            try {
              var res = merge((m.list || []).map(fromRow), pools, m.marks || []);
              await fetchSyn(res.list);
              progress('💾 แอปกำลังบันทึก…');
              reply({ type: 'nv-save', list: res.list.map(toRow), added: res.added, updated_at: new Date().toISOString() });
            } catch (e) {
              working = false;
              progress('');
              log('❌ ' + e.message, '#f28b82');
              reply({ type: 'nv-abort', error: e.message });
            }
          })();
        } else if (m.type === 'nv-done') {
          window.removeEventListener('message', onMsg);
          progress('');
          log('✅ อัปเดตแล้ว! ' + (m.added ? 'เพิ่มเรื่องใหม่ ' + m.added + ' เรื่อง' : 'รายการพร้อมแล้ว') + ' — กลับไปที่แอป › 💡 แนะนำ รายการจะโหลดใหม่เอง (แท็บแอปที่เพิ่งเปิดปิดได้)', '#6fd3ad');
        } else if (m.type === 'nv-error') {
          window.removeEventListener('message', onMsg);
          progress('');
          send.disabled = false;
          log('❌ แอปบันทึกไม่ได้: ' + m.error + ' — ลองอีกครั้ง หรือกด “ดาวน์โหลดไฟล์แทน”', '#f28b82');
        }
      }
      window.addEventListener('message', onMsg);
      var w = window.open(appUrl + '#sg-bridge', 'nv_bridge');
      if (!w) {
        window.removeEventListener('message', onMsg);
        log('เปิดแท็บแอปไม่ได้ (ป๊อปอัปถูกบล็อก) — กด “ดาวน์โหลดไฟล์แทน”', '#f0a94d');
        return;
      }
      send.disabled = true;
      log('เปิดแอปในแท็บใหม่แล้ว — กำลังส่งข้อมูล อย่าปิดแท็บนี้');
    };
  }

  function download(obj, name) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ---- main ---- */
  try {
    log('เริ่มเก็บข้อมูลจาก ReadAWrite… ใช้เวลาประมาณ 1–3 นาที อย่าปิดแท็บนี้');
    var t1raw = await fetchT1();
    var t2raw = await fetchTagLists('② จีนโบราณ + เกิดใหม่', T2_SPECS);
    var t3raw = await fetchTagLists('③ ไทยย้อนยุค', T3_SPECS);
    var pools = { t1: buildPool(t1raw, 't1'), t2: buildPool(t2raw, 't2'), t3: buildPool(t3raw, 't3') };
    log('พบนิยายที่ตรงเงื่อนไข: ① ' + pools.t1.length + ' · ② ' + pools.t2.length + ' · ③ ' + pools.t3.length + ' เรื่อง');
    ['t1', 't2', 't3'].forEach(function (k) {
      var top = pools[k][0];
      if (top) console.log('[นิยายแนะนำ] ' + k + ' #1: ' + top.name + ' — ' + top.views.toLocaleString('en-US') + ' views');
    });
    if (!pools.t1.length && !pools.t2.length && !pools.t3.length) throw new Error('ไม่พบข้อมูลเลย — API อาจเปลี่ยน ลองใหม่อีกครั้งหรือแจ้งผู้พัฒนา');

    var state = null;
    if (CFG.u && CFG.t) {
      progress('🔗 เชื่อมต่อ Google Sheet…');
      try { state = await gas({ action: 'sg_state' }); }
      catch (e) { console.log('[นิยายแนะนำ] direct Sheet access blocked on this page (' + e.message + ') — using the app handoff'); }
    }

    if (state) {
      var res = merge((state.list || []).map(fromRow), pools, state.marks || []);
      await fetchSyn(res.list);
      progress('💾 กำลังบันทึกลง Google Sheet…');
      await gas({ action: 'sg_save', list: res.list.map(toRow), updated_at: new Date().toISOString() });
      progress('');
      log('✅ อัปเดตแล้ว! ' + (res.added ? 'เพิ่มเรื่องใหม่ ' + res.added + ' เรื่อง' : 'รายการพร้อมแล้ว') + ' — เปิดแอป › 💡 แนะนำ แล้วกดโหลดใหม่', '#6fd3ad');
    } else {
      progress('');
      offerHandoff(pools);
    }
  } catch (e) {
    progress('');
    log('❌ ' + e.message, '#f28b82');
  }
})();
