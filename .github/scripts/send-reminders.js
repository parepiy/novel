/* Scheduled Web Push sender for reading reminders.
 * Runs from GitHub Actions on a cron. Pulls due reminders + push
 * subscriptions from the Apps Script endpoint, sends a push for each due
 * reminder, then marks it sent. Requires these env vars (GitHub secrets):
 *   GAS_URL, GAS_SECRET, VAPID_PUBLIC, VAPID_PRIVATE, [VAPID_SUBJECT] */
const webpush = require('web-push');

const GAS_URL = process.env.GAS_URL;
const SECRET = process.env.GAS_SECRET;
const SUBJECT = process.env.VAPID_SUBJECT || 'https://parepiy.github.io/novel/';
const DEFAULT_URL = 'https://parepiy.github.io/novel/';

if (!GAS_URL || !SECRET || !process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) {
  console.error('Missing required env vars: GAS_URL, GAS_SECRET, VAPID_PUBLIC, VAPID_PRIVATE');
  process.exit(1);
}

webpush.setVapidDetails(SUBJECT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

async function gas(body) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body)
  });
  return res.json();
}

(async () => {
  const data = await gas({ action: 'push_pull', token: SECRET });
  if (!data || !data.ok) {
    console.error('push_pull failed:', JSON.stringify(data));
    process.exit(1);
  }

  const now = Date.now();
  const all = data.reminders || [];
  const subs = data.subs || [];
  const due = all.filter(r => !Number(r.sent) && Number(r.remind_at) <= now);
  console.log(`reminders=${all.length} due=${due.length} subs=${subs.length}`);

  if (!due.length) { console.log('no due reminders'); return; }
  if (!subs.length) { console.log('no push subscriptions saved yet'); return; }

  for (const rem of due) {
    const payload = JSON.stringify({
      title: '📖 ถึงเวลาอ่านนิยาย',
      body: rem.title || '',
      url: rem.url || DEFAULT_URL,
      tag: 'reminder-' + rem.id
    });
    let delivered = false;
    for (const s of subs) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        delivered = true;
      } catch (err) {
        const code = err && err.statusCode;
        console.error(`push failed (${code || '?'}) for ${String(s.endpoint).slice(0, 40)}...`);
        if (code === 404 || code === 410) {
          try { await gas({ action: 'sub_remove', token: SECRET, endpoint: s.endpoint }); } catch (_) {}
        }
      }
    }
    if (delivered) {
      await gas({ action: 'remind_mark', token: SECRET, id: rem.id });
      console.log('sent + marked:', rem.id, '-', rem.title);
    } else {
      console.log('not delivered, leaving unmarked:', rem.id);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
