/*** ห้องสมุดนิยาย — Apps Script backend (complete file) ***
 *
 * Everything the app needs, in one file: library (add / edit / delete, reading
 * status, date added, date finished), cover upload, 🔔 reminders + push,
 * 💡 suggestions, 🔖 bookmarks, 💾 backup / restore, 🏷️ tag tools, ☑️ bulk edits.
 *
 * HOW TO INSTALL
 *  1. In the app: 🔑 → "📋 คัดลอก Code.gs" (this copies the file with YOUR secret filled in).
 *  2. Apps Script editor: open your script file, select ALL its text, paste, Save (💾).
 *  3. Deploy ▾ → Manage deployments → ✏️ → Version: New version → Deploy.
 *  4. Once: function dropdown → backfillAddedDates → ▶ Run (fills "date added" for old novels).
 */

// ---------------- settings ----------------
const SECRET = 'PASTE_YOUR_SECRET_HERE';   // must be the same secret as in the app (🔑)
const SHEET_GID = 1147646991;              // the tab the app reads / writes
const IMG_FOLDER = 'novel-covers';         // Google Drive folder for uploaded covers
// Optional: store covers on GitHub instead of Google Drive (avoids Drive permission errors).
// Put a GitHub token here once; it's then remembered in the script's own settings
// (Script Properties), so later copies of this file with an empty token keep using it.
// No token anywhere → covers go to Google Drive.
const GITHUB_TOKEN = '';
const GH_REPO = 'parepiy/novel';
const GH_BRANCH = 'main';
const GH_COVER_DIR = 'covers';
const ADDED_TZ = 'Asia/Bangkok';

// ---------------- helpers ----------------
function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sheets = ss.getSheets();
  for (const s of sheets) if (s.getSheetId() === SHEET_GID) return s;
  return sheets[0];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Column I "date added" → "yyyy-MM-dd" (also handles a cell Sheets turned into a real date)
function addedText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ADDED_TZ, 'yyyy-MM-dd');
  return (v || '').toString().trim();
}

function today_() { return Utilities.formatDate(new Date(), ADDED_TZ, 'yyyy-MM-dd'); }

// Write today's date as plain text into column I of a row
function stampAdded_(sh, row) {
  if (!sh.getRange(1, 9).getValue()) sh.getRange(1, 9).setValue('added_at');
  sh.getRange(row, 9).setNumberFormat('@').setValue(Utilities.formatDate(new Date(), ADDED_TZ, 'yyyy-MM-dd'));
}

// 📖 progress (chapter read up to), last-read date and 📝 note live in their OWN
// columns, found by their header name. The first time, they are added after your
// last used column — the script never writes into a column you already use.
const META_HEADERS = { progress: 'nv_progress', progress_at: 'nv_progress_at', note: 'nv_note', finished_at: 'nv_finished_at' };
function metaCols_(sh, create) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h == null ? '' : h).trim());
  const out = {};
  let next = lastCol + 1;
  let added = false;
  Object.keys(META_HEADERS).forEach(k => {
    const i = head.indexOf(META_HEADERS[k]);
    if (i >= 0) out[k] = i + 1;
    else if (create) { sh.getRange(1, next).setValue(META_HEADERS[k]); out[k] = next++; added = true; }
  });
  if (added) metaMigrate_(sh, head, out);
  return out;
}
// One-time move of what an earlier version saved in columns J–L (headers
// "progress" / "progress_at" / "note"). Only plain text is copied; nothing is deleted.
function metaMigrate_(sh, head, cols) {
  if (head[9] !== 'progress' || head[10] !== 'progress_at' || head[11] !== 'note') return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const old = sh.getRange(2, 10, last - 1, 3).getValues();
  old.forEach((r, i) => {
    const p = cellText_(r[0]), a = cellText_(r[1]), n = cellText_(r[2]);
    if (p && p !== 'CellImage') sh.getRange(i + 2, cols.progress).setNumberFormat('@').setValue(sgText_(p));
    if (a && /^\d{4}-\d{2}-\d{2}$/.test(a)) sh.getRange(i + 2, cols.progress_at).setNumberFormat('@').setValue(a);
    if (n && n !== 'CellImage') sh.getRange(i + 2, cols.note).setNumberFormat('@').setValue(sgText_(n));
  });
}
function metaSet_(sh, row, d) {
  const want = Object.keys(META_HEADERS).filter(k => d[k] !== undefined && d[k] !== null);
  if (!want.length) return;   // not sent → keep what's there
  const cols = metaCols_(sh, true);
  want.forEach(k => sh.getRange(row, cols[k]).setNumberFormat('@').setValue(sgText_(String(d[k]))));
}
// a cell as text; a picture placed in a cell (CellImage) or other object is not text
function cellText_(v) {
  if (v == null) return '';
  if (v instanceof Date) return addedText_(v);
  if (typeof v === 'object') return '';
  return String(v);
}

// Columns A..I = title, summary, url, tags(|-joined), source, cover, star, status, added_at; + the nv_ columns above
function readAll_() {
  const sh = getSheet_();
  const last = sh.getLastRow();
  const books = [];
  if (last >= 2) {
    const mc = metaCols_(sh, false);
    const vals = sh.getRange(2, 1, last - 1, Math.max(9, sh.getLastColumn())).getValues();
    const meta = (r, k) => mc[k] ? cellText_(r[mc[k] - 1]) : '';
    vals.forEach((r, i) => {
      const title = (r[0] || '').toString().trim();
      if (!title) return;
      books.push({
        row: i + 2,
        title: title,
        summary: (r[1] || '').toString(),
        url: (r[2] || '').toString(),
        tags: (r[3] || '').toString(),
        source: (r[4] || '').toString().trim(),
        cover: (r[5] || '').toString(),
        star: parseInt(r[6], 10) || 0,
        status: (r[7] || '').toString().trim(),
        added: addedText_(r[8]),
        progress: meta(r, 'progress'),
        progress_at: meta(r, 'progress_at'),
        note: meta(r, 'note'),
        finished_at: meta(r, 'finished_at')
      });
    });
  }
  return books;
}

// ---------------- cover upload (GitHub if a token is set, otherwise Google Drive) ----------------
function ghToken_() {
  const props = PropertiesService.getScriptProperties();
  if (GITHUB_TOKEN) {
    if (props.getProperty('GITHUB_TOKEN') !== GITHUB_TOKEN) props.setProperty('GITHUB_TOKEN', GITHUB_TOKEN);
    return GITHUB_TOKEN;
  }
  return props.getProperty('GITHUB_TOKEN') || '';
}

function saveImage_(b64, type, name) {
  return ghToken_() ? saveImageGitHub_(b64, type, name) : saveImageDrive_(b64, type, name);
}

function saveImageDrive_(b64, type, name) {
  const folders = DriveApp.getFoldersByName(IMG_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(IMG_FOLDER);
  const bytes = Utilities.base64Decode(b64);
  const blob = Utilities.newBlob(bytes, type || 'image/jpeg', name || ('cover_' + Date.now()));
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

function saveImageGitHub_(b64, type, name) {
  const ext = (type && type.indexOf('png') >= 0) ? 'png' : 'jpg';
  const base = (name || 'cover').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'cover';
  const path = GH_COVER_DIR + '/' + Date.now() + '_' + base + '.' + ext;
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + GH_REPO + '/contents/' + path, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ghToken_(), Accept: 'application/vnd.github+json', 'User-Agent': 'novel-app' },
    payload: JSON.stringify({ message: 'Add cover ' + path, content: b64, branch: GH_BRANCH }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('GitHub upload failed (' + code + '): ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).content.download_url;
}

// ---------------- endpoints ----------------
function doGet(e) {
  return json_({ ok: true, books: readAll_() });
}

function doPost(e) {
  try {
    let d;
    try { d = JSON.parse(e.postData.contents); }
    catch (err) { return json_({ ok: false, error: 'bad json' }); }

    const action = d.action;
    if (action === 'list') return json_({ ok: true, books: readAll_() });

    if (SECRET === 'PASTE_YOUR_SECRET_HERE') return json_({ ok: false, error: 'ยังไม่ได้ใส่รหัสลับ (SECRET) ในสคริปต์' });
    // everything below requires the secret
    if (d.token !== SECRET) return json_({ ok: false, error: 'unauthorized' });

    ghToken_();   // remember the GitHub token (if this file has one) for future copies of the script

    const rr = reminderRouter_(action, d);
    if (rr) return rr;
    const sr = suggestRouter_(action, d);
    if (sr) return sr;
    const lr = linkTitlesRouter_(action, d);
    if (lr) return lr;
    const cr = chapterWatchRouter_(action, d);
    if (cr) return cr;
    const br = bookmarksRouter_(action, d);
    if (br) return br;
    const tr = toolsRouter_(action, d);
    if (tr) return tr;

    const sh = getSheet_();

    if (action === 'add') {
      let cover = d.cover || '';
      if (d.imageB64) cover = saveImage_(d.imageB64, d.imageType, d.imageName);
      sh.appendRow([d.title || '', d.summary || '', d.url || '', d.tags || '', d.source || 'meb', cover, d.star || 0, d.status || '']);
      stampAdded_(sh, sh.getLastRow());
      if (d.status === 'finished' && d.finished_at === undefined) d.finished_at = today_();
      metaSet_(sh, sh.getLastRow(), d);
      return json_({ ok: true, row: sh.getLastRow(), cover: cover, meta: true });
    }

    if (action === 'edit') {
      const row = parseInt(d.row, 10);
      if (!row || row < 2) return json_({ ok: false, error: 'bad row' });
      let cover = d.cover || '';
      if (d.imageB64) cover = saveImage_(d.imageB64, d.imageType, d.imageName);
      // 🏁 set to Finished just now → remember the day (unless the app sent a date)
      const wasStatus = String(sh.getRange(row, 8).getValue() || '').trim().toLowerCase();
      if (d.status === 'finished' && wasStatus !== 'finished' && d.finished_at === undefined) d.finished_at = today_();
      // columns A..H only — the date added (column I) is kept as it is
      sh.getRange(row, 1, 1, 8).setValues([[d.title || '', d.summary || '', d.url || '', d.tags || '', d.source || 'meb', cover, d.star || 0, d.status || '']]);
      metaSet_(sh, row, d);   // progress / note / finished date, only when sent
      return json_({ ok: true, row: row, cover: cover, meta: true });
    }

    // 📖 "read up to": set after ✓ เสร็จ on a reminder. The title must still be on
    // that row (rows shift when a novel is deleted), otherwise it is found by title.
    if (action === 'progress') {
      let row = parseInt(d.row, 10);
      const want = String(d.title || '').trim();
      const at = row >= 2 ? String(sh.getRange(row, 1).getValue()).trim() : '';
      if (!want || at !== want) {
        const titles = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
        row = 0;
        for (let i = 1; i < titles.length; i++) if (String(titles[i][0]).trim() === want) { row = i + 1; break; }
      }
      if (!row) return json_({ ok: false, error: 'not found' });
      metaSet_(sh, row, { progress: d.progress, progress_at: d.progress_at });
      return json_({ ok: true, row: row });
    }

    if (action === 'delete') {
      const row = parseInt(d.row, 10);
      if (!row || row < 2) return json_({ ok: false, error: 'bad row' });
      sh.deleteRow(row);
      return json_({ ok: true });
    }

    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

// ---------------- 🔔 reminders + web push ----------------
function remindersSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('reminders');
  if (!sh) { sh = ss.insertSheet('reminders'); sh.appendRow(['id', 'title', 'url', 'remind_at', 'sent', 'created_at']); }
  return sh;
}

function subsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('push_subs');
  if (!sh) { sh = ss.insertSheet('push_subs'); sh.appendRow(['endpoint', 'p256dh', 'auth', 'created_at']); }
  return sh;
}

function readReminders_() {
  const vals = remindersSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    if (!vals[i][0]) continue;
    out.push({ id: String(vals[i][0]), title: vals[i][1], url: vals[i][2], remind_at: Number(vals[i][3]) || 0, sent: Number(vals[i][4]) || 0 });
  }
  return out;
}

function readSubs_() {
  const vals = subsSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    if (!vals[i][0]) continue;
    out.push({ endpoint: vals[i][0], p256dh: vals[i][1], auth: vals[i][2] });
  }
  return out;
}

function reminderRouter_(action, d) {
  if (action === 'remind_list') return json_({ ok: true, reminders: readReminders_() });
  if (action === 'push_pull')   return json_({ ok: true, reminders: readReminders_(), subs: readSubs_(), notices: sgRead_('push_queue', NOTICE_COLS) });
  // the GitHub sender delivered these one-off notices (e.g. 🆕 new chapters)
  if (action === 'notice_done') {
    const ids = (Array.isArray(d.ids) ? d.ids : [d.id]).map(String);
    const sh = sgSheet_('push_queue', NOTICE_COLS);
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) if (ids.indexOf(String(vals[i][0])) >= 0) sh.deleteRow(i + 1);
    return json_({ ok: true });
  }

  if (action === 'remind_add') {
    const sh = remindersSheet_();
    const id = 'r' + Date.now() + Math.floor(Math.random() * 1000);
    sh.appendRow([id, d.title || '', d.url || '', Number(d.remind_at) || 0, 0, new Date().toISOString()]);
    return json_({ ok: true, id: id });
  }

  // one reminder (id) or several at once (ids — e.g. "delete all of this novel")
  if (action === 'remind_delete') {
    const sh = remindersSheet_();
    const ids = (Array.isArray(d.ids) ? d.ids : [d.id]).map(String);
    const vals = sh.getDataRange().getValues();
    let deleted = 0;
    for (let i = vals.length - 1; i >= 1; i--) if (ids.indexOf(String(vals[i][0])) >= 0) { sh.deleteRow(i + 1); deleted++; }
    return json_({ ok: true, deleted: deleted });
  }

  // ⏩ snooze: a new time for one reminder (it will be sent again at the new time)
  if (action === 'remind_move') {
    const sh = remindersSheet_();
    const vals = sh.getDataRange().getValues();
    const ms = Number(d.remind_at) || 0;
    if (!ms) return json_({ ok: false, error: 'bad time' });
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(d.id)) {
      sh.getRange(i + 1, 4, 1, 2).setValues([[ms, 0]]);
      return json_({ ok: true, moved: true, id: String(d.id), remind_at: ms });
    }
    return json_({ ok: false, error: 'ไม่พบการแจ้งเตือนนี้ (อาจถูกลบไปแล้ว)' });
  }

  if (action === 'remind_mark') {   // used by the GitHub Action after sending
    const sh = remindersSheet_();
    const vals = sh.getDataRange().getValues();
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(d.id)) { sh.getRange(i + 1, 5).setValue(1); break; }
    return json_({ ok: true });
  }

  if (action === 'sub_save') {
    const sh = subsSheet_();
    const vals = sh.getDataRange().getValues();
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(d.endpoint)) {
      sh.getRange(i + 1, 1, 1, 4).setValues([[d.endpoint, d.p256dh, d.auth, new Date().toISOString()]]);
      return json_({ ok: true, updated: true });
    }
    sh.appendRow([d.endpoint || '', d.p256dh || '', d.auth || '', new Date().toISOString()]);
    return json_({ ok: true, added: true });
  }

  if (action === 'sub_remove') {    // prune a dead subscription (410/404)
    const sh = subsSheet_();
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === String(d.endpoint)) { sh.deleteRow(i + 1); break; }
    return json_({ ok: true });
  }

  return null;
}

// ---------------- 💡 suggestions (ReadAWrite) ----------------
const SG_COLS = ['tab', 'guid', 'uid', 'name', 'author', 'cat', 'ch', 'views', 'hearts', 'end', 'thumb', 'tags', 'hl', 'syn', 'is_new'];
const SG_MARK_COLS = ['guid', 'uid', 'name', 'mark', 'marked_at', 'reason', 'author', 'thumb', 'tab'];

function sgSheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, header.length).setValues([header]); }
  return sh;
}

// plain text; a leading ' stops text like "=..." becoming a formula
function sgText_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function sgRead_(name, header) {
  const vals = sgSheet_(name, header).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    if (!vals[i][0] && !vals[i][1]) continue;
    const o = {};
    header.forEach((c, j) => { o[c] = vals[i][j]; });
    out.push(o);
  }
  return out;
}

function sgReasons_() {
  try {
    const v = JSON.parse(PropertiesService.getScriptProperties().getProperty('sg_reasons') || 'null');
    return Array.isArray(v) ? v : null;   // null = never saved → the app uses its defaults
  } catch (e) { return null; }
}

function suggestRouter_(action, d) {
  if (action === 'sg_state') {
    return json_({
      ok: true,
      list: sgRead_('suggest_list', SG_COLS),
      marks: sgRead_('suggest_marks', SG_MARK_COLS),
      reasons: sgReasons_(),
      updated_at: PropertiesService.getScriptProperties().getProperty('sg_updated_at') || ''
    });
  }

  if (action === 'sg_mark') {
    const guid = String(d.guid || '');
    const uid = String(d.uid || '');
    if (!guid) return json_({ ok: false, error: 'missing guid' });
    const sh = sgSheet_('suggest_marks', SG_MARK_COLS);
    const vals = sh.getDataRange().getValues();
    let found = -1;
    for (let i = 1; i < vals.length; i++) {
      const g = String(vals[i][0]), u = String(vals[i][1]);
      if (g === guid || (uid && (u === uid || g === uid))) { found = i + 1; break; }
    }
    if (!d.mark) {
      if (found > 0) sh.deleteRow(found);
      return json_({ ok: true, cleared: true });
    }
    sh.getRange(1, 1, 1, SG_MARK_COLS.length).setValues([SG_MARK_COLS]);   // adds new columns to an old sheet
    const reason = Array.isArray(d.reason) ? d.reason.join('|') : (d.reason || '');
    const row = [guid, uid, d.name || '', d.mark, new Date().toISOString(),
      d.mark === 'not_interested' ? reason : '', d.author || '', d.thumb || '', d.tab || ''].map(sgText_);
    const r = found > 0 ? found : sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, SG_MARK_COLS.length).setNumberFormat('@').setValues([row]);
    return json_({ ok: true, reason_saved: true });
  }

  // your list of "not interested" reasons (shared by all your devices)
  if (action === 'sg_reasons') {
    const list = (Array.isArray(d.list) ? d.list : [])
      .map(x => String(x || '').trim()).filter(Boolean).slice(0, 60);
    PropertiesService.getScriptProperties().setProperty('sg_reasons', JSON.stringify(list));
    return json_({ ok: true, reasons: list });
  }

  if (action === 'sg_save') {
    const list = Array.isArray(d.list) ? d.list : [];
    const sh = sgSheet_('suggest_list', SG_COLS);
    sh.clearContents();
    sh.getRange(1, 1, 1, SG_COLS.length).setValues([SG_COLS]);
    if (list.length) {
      const rows = list.map(o => SG_COLS.map(c => sgText_(o[c])));
      sh.getRange(2, 1, rows.length, SG_COLS.length).setNumberFormat('@').setValues(rows);
    }
    PropertiesService.getScriptProperties().setProperty('sg_updated_at', String(d.updated_at || new Date().toISOString()));
    return json_({ ok: true, count: list.length });
  }

  return null;
}

// ---------------- 🔔 chapter titles for reminder links ----------------
// The app sends the reminder links; Google fetches each page once and reads its
// title. Results are kept in the "link_titles" sheet so each link is fetched
// only once (failed ones are retried after 6 hours).
const LT_COLS = ['url', 'title', 'status', 'fetched_at', 'page_title', 'og_title', 'parent', 'image', 'novel'];
const LT_RETRY_MS = 6 * 3600 * 1000;

function ltDecode_(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function ltMeta_(html, prop) {
  const p = prop.replace(/[.:]/g, '\\$&');
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) ||
            html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + p + '["\']', 'i'));
  return m ? ltDecode_(m[1]) : '';
}

// title = og:title (usually the cleanest) or <title>; the rest helps the app
// work out the novel's name: the page <title>, og:title, and the novel's own
// page (the first readawrite.com/a/… link on a chapter page)
function ltExtract_(html) {
  const og = ltMeta_(html, 'og:title');
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const page = t ? ltDecode_(t[1]) : '';
  const a = html.match(/href=["'](?:https?:\/\/(?:www\.)?readawrite\.com)?\/a\/([0-9a-z]{6,})["'?#]/i);
  return { title: og || page, page: page, og: og, parent: a ? 'https://www.readawrite.com/a/' + a[1] : '',
    image: ltMeta_(html, 'og:image') || ltMeta_(html, 'twitter:image') };   // 🖼️ the cover shown when the link is shared
}
// a relative or protocol-less image link → a full https link
function ltAbs_(img, pageUrl) {
  img = String(img || '').trim();
  if (!img) return '';
  if (/^\/\//.test(img)) return 'https:' + img;
  if (/^\//.test(img)) { const o = String(pageUrl).match(/^https?:\/\/[^\/]+/); return o ? o[0] + img : ''; }
  return /^https?:\/\//i.test(img) ? img : '';
}

// an anti-bot / error page instead of the real chapter
function ltBlocked_(title) {
  return /just a moment|attention required|access denied|security check|captcha|cloudflare|ยืนยันตัวตน|forbidden|not found|404/i.test(title);
}

function ltFetch_(urls) {
  const req = u => ({
    url: u, muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'th,en;q=0.8' }
  });
  try { return UrlFetchApp.fetchAll(urls.map(req)); }
  catch (e) {   // one bad link fails the whole batch → fetch one by one
    return urls.map(u => { try { return UrlFetchApp.fetch(u, req(u)); } catch (err) { return null; } });
  }
}

function linkTitlesRouter_(action, d) {
  if (action !== 'link_titles') return null;
  return json_({ ok: true, titles: ltLookup_(d.urls) });
}

// url → { title, status, page, og, parent, image, novel }; read from the sheet, fetched when new
function ltLookup_(list) {
  const urls = [];
  (Array.isArray(list) ? list : []).forEach(u => {
    u = String(u || '').trim();
    if (/^https?:\/\//i.test(u) && urls.indexOf(u) < 0 && urls.length < 30) urls.push(u);
  });
  const sh = sgSheet_('link_titles', LT_COLS);
  const vals = sh.getDataRange().getValues();
  const rowOf = {};
  for (let i = 1; i < vals.length; i++) if (vals[i][0]) rowOf[String(vals[i][0])] = i + 1;
  const out = {};
  const todo = [];
  urls.forEach(u => {
    const r = rowOf[u];
    if (r) {
      const v = vals[r - 1];
      const fresh = Date.now() - new Date(v[3]).getTime() < LT_RETRY_MS;
      const ok = String(v[2]) === 'ok';
      // saved before page_title/og_title, covers ('image' empty = never looked) or the novel's
      // name from its own page ('novel' empty while there is a novel page) → read it once more
      const old = ok && ((!v[4] && !v[5]) || !v[7] || (v[6] && !v[8]));
      if (!old && (ok || fresh)) {
        const none = x => String(x || '') === 'none' ? '' : String(x || '');
        out[u] = { title: String(v[1] || ''), status: String(v[2] || ''), page: String(v[4] || ''), og: String(v[5] || ''), parent: String(v[6] || ''),
          image: none(v[7]), novel: none(v[8]) };
        return;
      }
    }
    todo.push(u);
  });
  if (todo.length) {
    const resps = ltFetch_(todo);
    const got = todo.map((u, i) => {
      const res = resps[i];
      let info = { title: '', page: '', og: '', parent: '', image: '' }, status = 'error';
      if (res) {
        const code = res.getResponseCode();
        if (code === 200) {
          info = ltExtract_(res.getContentText('UTF-8').slice(0, 300000));
          status = !info.title ? 'no_title' : ltBlocked_(info.title) ? 'blocked' : 'ok';
          if (status !== 'ok') info = { title: '', page: '', og: '', parent: '', image: '' };
          info.image = ltAbs_(info.image, u);
        } else status = 'http_' + code;
      }
      return { u: u, info: info, status: status };
    });
    // the novel's own page (readawrite.com/a/…): its real name, and its cover when the chapter has none.
    // A chapter page's title is usually "novel - chapter", but not always (e.g. collections).
    const parents = [];
    got.forEach(g => { if (g.status === 'ok' && g.info.parent && parents.indexOf(g.info.parent) < 0 && parents.length < 20) parents.push(g.info.parent); });
    const pImg = {}, pName = {};
    if (parents.length) {
      const pr = ltFetch_(parents);
      parents.forEach((pu, i) => {
        const res = pr[i];
        if (!res || res.getResponseCode() !== 200) return;
        const x = ltExtract_(res.getContentText('UTF-8').slice(0, 300000));
        pImg[pu] = ltAbs_(x.image, pu);
        if (x.title && !ltBlocked_(x.title)) pName[pu] = x.title;
      });
    }
    sh.getRange(1, 1, 1, LT_COLS.length).setValues([LT_COLS]);
    got.forEach(g => {
      const info = g.info;
      if (g.status === 'ok' && !info.image && info.parent) info.image = pImg[info.parent] || '';
      info.novel = g.status === 'ok' && info.parent ? (pName[info.parent] || '') : '';
      out[g.u] = { title: info.title, status: g.status, page: info.page, og: info.og, parent: info.parent, image: info.image, novel: info.novel };
      const r = rowOf[g.u] || sh.getLastRow() + 1;
      rowOf[g.u] = r;
      sh.getRange(r, 1, 1, LT_COLS.length).setNumberFormat('@')
        .setValues([[g.u, info.title, g.status, new Date().toISOString(), info.page, info.og, info.parent,
          g.status === 'ok' ? (info.image || 'none') : '', g.status === 'ok' && info.parent ? (info.novel || 'none') : ''].map(sgText_)]);
    });
  }
  return out;
}

// ---------------- 🆕 new-chapter alerts ----------------
// The 💡 bookmarklet looks up your Reading novels on ReadAWrite and sends their
// chapter counts here. chapters = latest count, seen = the count you last
// acknowledged (✓ รับทราบ), so "new" = chapters - seen. When a count goes up,
// one push notice is queued for the GitHub sender (push_pull → notice_done).
const CW_COLS = ['aid', 'title', 'chapters', 'seen', 'end', 'found', 'updated', 'checked_at'];
const NOTICE_COLS = ['id', 'title', 'body', 'url', 'created_at'];

function chapterWatchRouter_(action, d) {
  if (action === 'cw_state') return json_({ ok: true, items: sgRead_('chapter_watch', CW_COLS) });

  if (action === 'cw_save' || action === 'cw_ack') {
    const sh = sgSheet_('chapter_watch', CW_COLS);
    const vals = sh.getDataRange().getValues();
    const norm = t => String(t || '').trim().toLowerCase();
    const findRow = (aid, title) => {
      for (let i = 1; i < vals.length; i++) {
        if (aid && String(vals[i][0]) === aid) return i + 1;
        if (norm(vals[i][1]) && norm(vals[i][1]) === norm(title)) return i + 1;
      }
      return 0;
    };
    const write = (r, row) => {
      sh.getRange(r, 1, 1, CW_COLS.length).setNumberFormat('@').setValues([row.map(v => sgText_(v))]);
      while (vals.length < r) vals.push([]);
      vals[r - 1] = row;
    };

    if (action === 'cw_ack') {
      const r = findRow(String(d.aid || ''), d.title);
      if (!r) return json_({ ok: false, error: 'not found' });
      const v = vals[r - 1];
      const row = CW_COLS.map((c, j) => v[j] == null ? '' : v[j]);
      row[3] = String(parseInt(d.seen, 10) || parseInt(v[2], 10) || 0);
      write(r, row);
      return json_({ ok: true });
    }

    const now = new Date().toISOString();
    const fresh = [];
    (Array.isArray(d.items) ? d.items : []).forEach(it => {
      const title = String(it.title || '').trim();
      if (!title) return;
      const aid = String(it.aid || '');
      const ch = parseInt(it.chapters, 10) || 0;
      const found = it.found && ch > 0;
      const r = findRow(aid, title);
      if (r) {
        const v = vals[r - 1];
        const prev = parseInt(v[2], 10) || 0;
        let seen = parseInt(v[3], 10) || 0;
        if (!found) {   // not found this time: keep the old counts
          write(r, [v[0], title, prev, seen, v[4], 0, v[6], now]);
          return;
        }
        if (!prev && !seen) seen = ch;   // first real count → nothing "new" yet
        if (prev && ch > prev && ch > seen) fresh.push({ title: title, n: ch - seen });
        write(r, [aid || v[0], title, ch, seen, it.end ? 1 : 0, 1, it.updated || '', now]);
      } else {
        write(sh.getLastRow() + 1, [aid, title, found ? ch : 0, found ? ch : 0, it.end ? 1 : 0, found ? 1 : 0, it.updated || '', now]);
      }
    });
    if (fresh.length) {
      const body = fresh.map(f => f.title + ' +' + f.n + ' ตอน').join(' · ');
      const q = sgSheet_('push_queue', NOTICE_COLS);
      q.appendRow(['n' + Date.now() + Math.floor(Math.random() * 1000), fresh.length > 1 ? '🆕 มีตอนใหม่ ' + fresh.length + ' เรื่อง' : '🆕 มีตอนใหม่', body,
        String(d.app_url || 'https://parepiy.github.io/novel/').split('#')[0] + '#newch', now].map(sgText_));
    }
    return json_({ ok: true, items: sgRead_('chapter_watch', CW_COLS), fresh: fresh.length });
  }
  return null;
}

// ---------------- 🔖 bookmarks ----------------
// One row per bookmark. The app makes the id, so saving the same bookmark twice
// (a retry) just updates it. title = the novel's name (in your library or not).
const BM_COLS = ['id', 'title', 'source', 'chapter', 'note', 'url', 'created_at', 'updated_at'];

function bookmarksRouter_(action, d) {
  if (action === 'bm_list') return json_({ ok: true, items: sgRead_('bookmarks', BM_COLS) });

  if (action === 'bm_save') {
    const id = String(d.id || '').trim();
    const title = String(d.title || '').trim();
    const chapter = String(d.chapter || '').trim();
    if (!id || !title || !chapter) return json_({ ok: false, error: 'ต้องมีชื่อเรื่องและเลขตอน' });
    const sh = sgSheet_('bookmarks', BM_COLS);
    const vals = sh.getDataRange().getValues();
    let r = 0;
    for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === id) { r = i + 1; break; }
    const now = new Date().toISOString();
    const created = r ? String(vals[r - 1][6] || now) : now;
    const row = [id, title, d.source === 'raw' ? 'raw' : 'meb', chapter, String(d.note || ''), String(d.url || ''), created, now];
    sh.getRange(r || sh.getLastRow() + 1, 1, 1, BM_COLS.length).setNumberFormat('@').setValues([row.map(sgText_)]);
    return json_({ ok: true, item: BM_COLS.reduce((o, c, j) => { o[c] = row[j]; return o; }, {}) });
  }

  if (action === 'bm_delete') {
    const sh = sgSheet_('bookmarks', BM_COLS);
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === String(d.id)) sh.deleteRow(i + 1);
    return json_({ ok: true });
  }
  return null;
}

// ---------------- 💾 backup / 🏷️ tags / ☑️ bulk edits / 🖼️ covers / 📖 reading log ----------------
const RL_COLS = ['id', 'date', 'title', 'chapter', 'url', 'via', 'created_at'];
const BK_PREFIX = 'backup_';   // safety copies made before a restore
const BK_KEEP = 3;             // safety copies kept per tab

// a cell for the backup file: a date → text, a picture in a cell → '' (pictures can't go in a file)
function bkCell_(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const t = Utilities.formatDate(v, ADDED_TZ, 'HH:mm:ss');
    return t === '00:00:00' ? Utilities.formatDate(v, ADDED_TZ, 'yyyy-MM-dd') : v.toISOString();
  }
  if (typeof v === 'object') return '';
  return v;
}

// the library row of a novel: the given row if the title is still there, otherwise found by title
function libRow_(titles, row, title) {
  const want = String(title || '').trim();
  if (!want) return 0;
  row = parseInt(row, 10) || 0;
  if (row >= 2 && row <= titles.length && String(titles[row - 1][0]).trim() === want) return row;
  for (let i = 1; i < titles.length; i++) if (String(titles[i][0]).trim() === want) return i + 1;
  return 0;
}
function splitTags_(s) { return String(s == null ? '' : s).split('|').map(t => t.trim()).filter(Boolean); }

function toolsRouter_(action, d) {
  // 💾 everything in the spreadsheet (every tab except the safety copies), as plain values
  if (action === 'backup_dump') {
    const ss = SpreadsheetApp.getActive();
    const libId = getSheet_().getSheetId();
    const sheets = {};
    ss.getSheets().forEach(sh => {
      const name = sh.getName();
      if (name.indexOf(BK_PREFIX) === 0) return;
      const vals = sh.getLastRow() ? sh.getDataRange().getValues().map(r => r.map(bkCell_)) : [];
      sheets[name] = { library: sh.getSheetId() === libId, values: vals };
    });
    return json_({ ok: true, app: 'novel', version: 1, created_at: new Date().toISOString(), spreadsheet: ss.getName(), sheets: sheets });
  }

  // 💾 put one tab back from a backup file. A copy of the tab as it is now is kept first
  // (backup_<tab>_<time>), so a restore can always be undone. In the library tab, pictures
  // placed in cells (they can't be in the file) stay with their novel, matched by title.
  if (action === 'backup_restore') {
    const vals = Array.isArray(d.values) ? d.values.filter(r => Array.isArray(r)) : [];
    const name = String(d.name || '').trim();
    if (!vals.length || !name) return json_({ ok: false, error: 'ไฟล์สำรองไม่มีข้อมูลของแท็บนี้' });
    if (name.indexOf(BK_PREFIX) === 0) return json_({ ok: false, error: 'skip' });
    const ss = SpreadsheetApp.getActive();
    const sh = d.library ? getSheet_() : (ss.getSheetByName(name) || ss.insertSheet(name));
    let copyName = '';
    if (sh.getLastRow() > 0) {
      const stamp = Utilities.formatDate(new Date(), ADDED_TZ, 'yyyyMMdd_HHmmss');
      const base = BK_PREFIX + sh.getName().slice(0, 60) + '_';
      const copy = sh.copyTo(ss);
      copyName = base + stamp;
      copy.setName(copyName);
      ss.getSheets().filter(s => s.getName().indexOf(base) === 0).map(s => s.getName()).sort().reverse()
        .slice(BK_KEEP).forEach(n => ss.deleteSheet(ss.getSheetByName(n)));
    }
    const width = Math.max(1, ...vals.map(r => r.length));
    const rows = vals.map(r => { const a = r.slice(0, width); while (a.length < width) a.push(''); return a.map(v => typeof v === 'string' ? sgText_(v) : (v == null ? '' : v)); });
    const lastRow = Math.max(sh.getLastRow(), 1), lastCol = Math.max(sh.getLastColumn(), width);
    const keep = {};   // picture columns (library only)
    if (d.library && sh.getLastRow() > 0) {
      const cur = sh.getRange(1, 1, lastRow, Math.max(sh.getLastColumn(), 1)).getValues();
      cur.forEach(r => r.forEach((v, j) => { if (v && typeof v === 'object' && !(v instanceof Date)) keep[j + 1] = true; }));
    }
    let kept = 0, moved = 0;
    const cur = Object.keys(keep).length ? sh.getRange(1, 1, lastRow, Math.max(sh.getLastColumn(), 1)).getValues() : [];
    for (let c = 1; c <= lastCol; c++) {
      if (keep[c]) {
        // each picture goes with its novel (found by title), so pictures don't end up beside the wrong novel
        try {
          const pic = {};
          cur.forEach((r, i) => { const t = String(r[0] || '').trim(), v = r[c - 1]; if (i && t && v && typeof v === 'object' && !(v instanceof Date) && !pic[t]) pic[t] = v; });
          const col = rows.slice(1).map(r => [pic[String(r[0] || '').replace(/^'/, '').trim()] || '']);
          if (col.length) sh.getRange(2, c, col.length, 1).setValues(col);
          if (lastRow > rows.length) sh.getRange(rows.length + 1, c, lastRow - rows.length, 1).clearContent();
          moved++;
        } catch (e) { kept++; }   // couldn't move them: the column is left as it was (the safety copy has them)
        continue;
      }
      if (lastRow > rows.length || c > width) sh.getRange(c > width ? 1 : rows.length + 1, c, lastRow - (c > width ? 0 : rows.length), 1).clearContent();
      if (c <= width) sh.getRange(1, c, rows.length, 1).setNumberFormat('@').setValues(rows.map(r => [r[c - 1]]));
    }
    return json_({ ok: true, name: sh.getName(), rows: rows.length - 1, copy: copyName, picture_columns: moved, kept_picture_columns: kept });
  }

  // 🏷️ rename / merge / delete tags in every novel. from = the tags to change, to = the new name ('' = delete)
  if (action === 'tag_edit') {
    const from = (Array.isArray(d.from) ? d.from : [d.from]).map(t => String(t || '').trim()).filter(Boolean);
    const to = String(d.to || '').trim();
    if (!from.length) return json_({ ok: false, error: 'ไม่มีแท็กที่จะแก้' });
    const sh = getSheet_();
    const last = sh.getLastRow();
    if (last < 2) return json_({ ok: true, changed: 0 });
    const rng = sh.getRange(2, 4, last - 1, 1);
    const vals = rng.getValues();
    let changed = 0;
    const out = vals.map(r => {
      const tags = splitTags_(r[0]);
      if (!tags.some(t => from.indexOf(t) >= 0)) return [r[0]];
      const next = [];
      tags.forEach(t => {
        const nt = from.indexOf(t) >= 0 ? to : t;
        if (nt && next.indexOf(nt) < 0) next.push(nt);
      });
      changed++;
      return [sgText_(next.join('|'))];
    });
    if (changed) rng.setValues(out);
    return json_({ ok: true, changed: changed });
  }

  // ☑️ many novels at once: items = [{row, title}]; status and/or add_tags / remove_tags
  if (action === 'bulk_edit') {
    const sh = getSheet_();
    const titles = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
    const add = (Array.isArray(d.add_tags) ? d.add_tags : []).map(t => String(t || '').trim()).filter(Boolean);
    const rem = (Array.isArray(d.remove_tags) ? d.remove_tags : []).map(t => String(t || '').trim()).filter(Boolean);
    const setStatus = typeof d.status === 'string';
    let changed = 0, missing = 0;
    (Array.isArray(d.items) ? d.items : []).forEach(it => {
      const row = libRow_(titles, it.row, it.title);
      if (!row) { missing++; return; }
      if (add.length || rem.length) {
        const tags = splitTags_(sh.getRange(row, 4).getValue()).filter(t => rem.indexOf(t) < 0);
        add.forEach(t => { if (tags.indexOf(t) < 0) tags.push(t); });
        sh.getRange(row, 4).setValue(sgText_(tags.join('|')));
      }
      if (setStatus) {
        const was = String(sh.getRange(row, 8).getValue() || '').trim().toLowerCase();
        sh.getRange(row, 8).setValue(d.status);
        if (d.status === 'finished' && was !== 'finished') metaSet_(sh, row, { finished_at: today_() });
      }
      changed++;
    });
    return json_({ ok: true, changed: changed, missing: missing });
  }

  // ☑️ delete many novels. Only rows that still hold that title are deleted (bottom first, so rows don't shift).
  if (action === 'bulk_delete') {
    const sh = getSheet_();
    const titles = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
    const rows = [];
    (Array.isArray(d.items) ? d.items : []).forEach(it => {
      const row = parseInt(it.row, 10) || 0;
      if (row >= 2 && row <= titles.length && String(titles[row - 1][0]).trim() === String(it.title || '').trim() && rows.indexOf(row) < 0) rows.push(row);
    });
    rows.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
    return json_({ ok: true, deleted: rows.length });
  }

  // 🖼️ library novels with a link but no cover: read the cover from the link's page (a few per call)
  if (action === 'fill_covers') {
    const sh = getSheet_();
    const last = sh.getLastRow();
    if (last < 2) return json_({ ok: true, filled: [], tried: 0, remaining: 0 });
    const vals = sh.getRange(2, 1, last - 1, 6).getValues();
    const lt = sgSheet_('link_titles', LT_COLS).getDataRange().getValues();
    const seen = {};
    for (let i = 1; i < lt.length; i++) if (lt[i][0]) seen[String(lt[i][0])] = lt[i];
    // no use asking again: read fine but the page has no picture, or failed in the last 6 hours
    const hopeless = u => {
      const v = seen[u];
      if (!v) return false;
      if (String(v[2]) === 'ok') return String(v[7]) === 'none';
      return Date.now() - new Date(v[3]).getTime() < LT_RETRY_MS;
    };
    const todo = [];
    vals.forEach((r, i) => {
      const title = String(r[0] || '').trim(), url = String(r[2] || '').trim(), cover = cellText_(r[5]).trim();
      if (title && !cover && /^https?:\/\//i.test(url) && !hopeless(url)) todo.push({ row: i + 2, title: title, url: url });
    });
    const n = Math.min(Math.max(parseInt(d.limit, 10) || 8, 1), 15);
    const batch = todo.slice(0, n);
    const info = batch.length ? ltLookup_(batch.map(x => x.url)) : {};
    const filled = [];
    batch.forEach(x => {
      const img = info[x.url] && info[x.url].status === 'ok' ? info[x.url].image : '';
      if (!img) return;
      sh.getRange(x.row, 6).setValue(img);
      filled.push({ row: x.row, title: x.title, cover: img });
    });
    return json_({ ok: true, filled: filled, tried: batch.length, remaining: todo.length - batch.length });
  }

  // 📖 reading log: one row per chapter you finished (✓ เสร็จ) or bookmarked; the same chapter counts once
  if (action === 'log_list') return json_({ ok: true, items: sgRead_('read_log', RL_COLS) });
  if (action === 'log_read') {
    const title = String(d.title || '').trim();
    if (!title) return json_({ ok: false, error: 'missing title' });
    const chapter = String(d.chapter || '').trim(), url = String(d.url || '').trim();
    const sh = sgSheet_('read_log', RL_COLS);
    const vals = sh.getDataRange().getValues();
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
    const key = norm(title) + '|' + norm(chapter || url);
    if (chapter || url) for (let i = 1; i < vals.length; i++) {
      if (norm(vals[i][2]) + '|' + norm(vals[i][3] || vals[i][4]) === key) return json_({ ok: true, dup: true });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : today_();
    const row = ['l' + Date.now() + Math.floor(Math.random() * 1000), date, title, chapter, url, String(d.via || ''), new Date().toISOString()];
    sh.getRange(sh.getLastRow() + 1, 1, 1, RL_COLS.length).setNumberFormat('@').setValues([row.map(sgText_)]);
    return json_({ ok: true, item: RL_COLS.reduce((o, c, j) => { o[c] = row[j]; return o; }, {}) });
  }
  return null;
}

// ---------------- run these by hand from the editor ----------------

// Once: fill in "date added" (column I) for existing novels from their cover's upload time.
// Drive covers → the file's creation date; GitHub covers → the time in the file name.
// Novels without such a cover stay blank (shown as "ไม่ทราบวันที่").
function backfillAddedDates() {
  const sh = getSheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  if (!sh.getRange(1, 9).getValue()) sh.getRange(1, 9).setValue('added_at');
  const vals = sh.getRange(2, 1, last - 1, 9).getValues();
  let filled = 0, unknown = 0, kept = 0;
  vals.forEach((r, i) => {
    if (!r[0]) return;
    if (r[8]) { kept++; return; }
    const cover = (r[5] || '').toString();
    let d = null;
    const gh = cover.match(/covers\/(\d{13})_/);
    if (gh) d = new Date(Number(gh[1]));
    if (!d) {
      const m = cover.match(/[?&]id=([\w-]{20,})/) || cover.match(/\/d\/([\w-]{20,})/);
      if (m) { try { d = DriveApp.getFileById(m[1]).getDateCreated(); } catch (e) {} }
    }
    if (d) {
      sh.getRange(i + 2, 9).setNumberFormat('@').setValue(Utilities.formatDate(d, ADDED_TZ, 'yyyy-MM-dd'));
      filled++;
    } else unknown++;
  });
  Logger.log('ใส่วันที่จากรูปปกแล้ว ' + filled + ' เรื่อง · มีวันที่อยู่แล้ว ' + kept + ' เรื่อง · ไม่ทราบวันที่ ' + unknown + ' เรื่อง');
}

// If cover uploads to Drive ever say "not authorized": run this once and click Allow.
function authorizeDrive() {
  const folders = DriveApp.getFoldersByName(IMG_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(IMG_FOLDER);
  const f = folder.createFile(Utilities.newBlob('ok', 'text/plain', 'auth_test.txt'));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  f.setTrashed(true);
  Logger.log('Drive authorized OK');
}

// Only if you use a GitHub token: run once to allow the script to reach GitHub (log should show 200).
function authorizeGitHub() {
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + GH_REPO, {
    headers: { Authorization: 'Bearer ' + ghToken_(), Accept: 'application/vnd.github+json', 'User-Agent': 'novel-app' },
    muteHttpExceptions: true
  });
  Logger.log('GitHub auth: ' + res.getResponseCode() + ' (200 = OK)');
}
