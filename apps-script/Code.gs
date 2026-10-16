/*** ห้องสมุดนิยาย — Apps Script backend (complete file) ***
 *
 * Everything the app needs, in one file: library (add / edit / delete, reading
 * status, date added), cover upload, 🔔 reminders + push, 💡 suggestions.
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
// Leave GITHUB_TOKEN empty to keep using Drive.
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

// Write today's date as plain text into column I of a row
function stampAdded_(sh, row) {
  if (!sh.getRange(1, 9).getValue()) sh.getRange(1, 9).setValue('added_at');
  sh.getRange(row, 9).setNumberFormat('@').setValue(Utilities.formatDate(new Date(), ADDED_TZ, 'yyyy-MM-dd'));
}

// Columns A..I = title, summary, url, tags(|-joined), source, cover, star, status, added_at
function readAll_() {
  const sh = getSheet_();
  const last = sh.getLastRow();
  const books = [];
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, 9).getValues();
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
        added: addedText_(r[8])
      });
    });
  }
  return books;
}

// ---------------- cover upload (GitHub if a token is set, otherwise Google Drive) ----------------
function saveImage_(b64, type, name) {
  return GITHUB_TOKEN ? saveImageGitHub_(b64, type, name) : saveImageDrive_(b64, type, name);
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
    headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'novel-app' },
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

    const rr = reminderRouter_(action, d);
    if (rr) return rr;
    const sr = suggestRouter_(action, d);
    if (sr) return sr;

    const sh = getSheet_();

    if (action === 'add') {
      let cover = d.cover || '';
      if (d.imageB64) cover = saveImage_(d.imageB64, d.imageType, d.imageName);
      sh.appendRow([d.title || '', d.summary || '', d.url || '', d.tags || '', d.source || 'meb', cover, d.star || 0, d.status || '']);
      stampAdded_(sh, sh.getLastRow());
      return json_({ ok: true, row: sh.getLastRow(), cover: cover });
    }

    if (action === 'edit') {
      const row = parseInt(d.row, 10);
      if (!row || row < 2) return json_({ ok: false, error: 'bad row' });
      let cover = d.cover || '';
      if (d.imageB64) cover = saveImage_(d.imageB64, d.imageType, d.imageName);
      // columns A..H only — the date added (column I) is kept as it is
      sh.getRange(row, 1, 1, 8).setValues([[d.title || '', d.summary || '', d.url || '', d.tags || '', d.source || 'meb', cover, d.star || 0, d.status || '']]);
      return json_({ ok: true, row: row, cover: cover });
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
  if (action === 'push_pull')   return json_({ ok: true, reminders: readReminders_(), subs: readSubs_() });

  if (action === 'remind_add') {
    const sh = remindersSheet_();
    const id = 'r' + Date.now() + Math.floor(Math.random() * 1000);
    sh.appendRow([id, d.title || '', d.url || '', Number(d.remind_at) || 0, 0, new Date().toISOString()]);
    return json_({ ok: true, id: id });
  }

  if (action === 'remind_delete') {
    const sh = remindersSheet_();
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === String(d.id)) { sh.deleteRow(i + 1); break; }
    return json_({ ok: true });
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
const SG_MARK_COLS = ['guid', 'uid', 'name', 'mark', 'marked_at'];

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

function suggestRouter_(action, d) {
  if (action === 'sg_state') {
    return json_({
      ok: true,
      list: sgRead_('suggest_list', SG_COLS),
      marks: sgRead_('suggest_marks', SG_MARK_COLS),
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
    const row = [guid, uid, d.name || '', d.mark, new Date().toISOString()].map(sgText_);
    const r = found > 0 ? found : sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, SG_MARK_COLS.length).setNumberFormat('@').setValues([row]);
    return json_({ ok: true });
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

// Only if you set GITHUB_TOKEN: run once to allow the script to reach GitHub (log should show 200).
function authorizeGitHub() {
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + GH_REPO, {
    headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'novel-app' },
    muteHttpExceptions: true
  });
  Logger.log('GitHub auth: ' + res.getResponseCode() + ' (200 = OK)');
}
