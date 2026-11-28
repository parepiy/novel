/* Scheduled Web Push sender for reading reminders.
 * Runs from GitHub Actions on a cron. Pulls due reminders + push
 * subscriptions from the Apps Script endpoint, sends a push for each due
 * reminder, then marks it sent. Also sends one-off notices queued by the
 * script (🆕 new chapters found by the 💡 bookmarklet) and clears them. Requires these env vars (GitHub secrets):
 *   GAS_URL, GAS_SECRET, VAPID_PUBLIC, VAPID_PRIVATE, [VAPID_SUBJECT] */
const webpush = require('web-push');

const GAS_URL = process.env.GAS_URL;
const SECRET = process.env.GAS_SECRET;
const SUBJECT = process.env.VAPID_SUBJECT || 'https://parepiy.github.io/novel/';
const DEFAULT_URL = 'https://parepiy.github.io/novel/';
const WEEK = 7 * 24 * 60 * 60 * 1000;
// Reminders whose URL contains this repeat every week (the 💡 suggestion refresh).
const WEEKLY_MARK = '#suggest';

if (!GAS_URL || !SECRET || !process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) {
  console.error('Missing required env vars: GAS_URL, GAS_SECRET, VAPID_PUBLIC, VAPID_PRIVATE');
  process.exit(1);
}

webpush.setVapidDetails(SUBJECT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

// Throws unless Apps Script answers 200 with ok:true (e.g. "busy" when its lock is taken), and gives up after 60 s.
async function gas(body) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const data = res.ok ? await res.json().catch(() => null) : null;
  if (!data || !data.ok) throw new Error(`${body.action} failed: ${(data && data.error) || 'HTTP ' + res.status}`);   // never dump the reply: it holds your reminders
  return data;
}

(async () => {
  const data = await gas({ action: 'push_pull', token: SECRET });

  const now = Date.now();
  const all = data.reminders || [];
  const subs = data.subs || [];
  const due = all.filter(r => !Number(r.sent) && Number(r.remind_at) <= now);
  const notices = data.notices || [];
  console.log(`reminders=${all.length} due=${due.length} notices=${notices.length} subs=${subs.length}`);

  if (!due.length && !notices.length) { console.log('nothing to send'); return; }
  if (!subs.length) { console.log('no push subscriptions saved yet'); return; }

  // send one payload to every saved device; drop subscriptions that are gone
  async function sendAll(payload) {
    let delivered = false;
    for (const s of subs) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        delivered = true;
      } catch (err) {
        const code = err && err.statusCode;
        console.error(`push failed (${code || '?'}) via ${(() => { try { return new URL(s.endpoint).host; } catch (_) { return '?'; } })()}`);
        if (code === 404 || code === 410) {
          try { await gas({ action: 'sub_remove', token: SECRET, endpoint: s.endpoint }); } catch (_) {}
        }
      }
    }
    return delivered;
  }

  // Each item on its own: one failed call doesn't stop the rest. A failure is retried on the next run.
  const fail = (id, e) => { process.exitCode = 1; console.error('failed, will retry:', id, '-', e.message); };

  for (const n of notices) {
    try {
      const ok = await sendAll(JSON.stringify({
        title: n.title || '🆕 มีตอนใหม่', body: n.body || '', url: n.url || DEFAULT_URL + '#newch', tag: 'notice-' + n.id
      }));
      if (ok) { await gas({ action: 'notice_done', token: SECRET, ids: [n.id] }); console.log('sent notice:', n.id); }   // ids only: this repo's Actions logs are public
      else console.log('notice not delivered, will retry:', n.id);
    } catch (e) { fail(n.id, e); }
  }

  for (const rem of due) {
    try {
      const weekly = String(rem.url || '').includes(WEEKLY_MARK);
      const payload = JSON.stringify({
        title: weekly ? '💡 นิยายแนะนำ' : '📖 ถึงเวลาอ่านนิยาย',
        body: rem.title || '',
        url: rem.url || DEFAULT_URL,
        tag: 'reminder-' + rem.id
      });
      const delivered = await sendAll(payload);
      if (delivered && weekly) {
        // Keep the same weekday/time: step forward whole weeks past "now".
        let next = Number(rem.remind_at) + WEEK;
        while (next <= now) next += WEEK;
        // Delete this week's only once next week's exists (an earlier run may already have added it).
        if (!all.some(r => r.url === rem.url && Number(r.remind_at) === next))
          await gas({ action: 'remind_add', token: SECRET, title: rem.title, url: rem.url, remind_at: next });
        await gas({ action: 'remind_delete', token: SECRET, id: rem.id });
        console.log('sent weekly:', rem.id, '- next at', new Date(next).toISOString());
      } else if (delivered) {
        await gas({ action: 'remind_mark', token: SECRET, id: rem.id });
        console.log('sent + marked:', rem.id);   // no titles in the public log
      } else {
        console.log('not delivered, leaving unmarked:', rem.id);
      }
    } catch (e) { fail(rem.id, e); }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
