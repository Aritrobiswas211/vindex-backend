const express = require('express');
const webpush = require('web-push');
const supabase = require('../db');

const router = express.Router();

// Generate these once with: npx web-push generate-vapid-keys
// Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY as env vars on Render.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@vindex.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// GET /api/push/public-key — frontend fetches this to register a subscription
router.get('/public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'Push notifications are not configured on the server yet.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — body: the PushSubscription object from the browser
router.post('/subscribe', async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }

  // Upsert on endpoint so re-subscribing (e.g. after clearing site data) doesn't duplicate rows.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, { onConflict: 'endpoint' });

  if (error) return res.status(500).json({ error: 'Could not save subscription.' });
  res.json({ ok: true });
});

// POST /api/push/unsubscribe — body: { endpoint }
router.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  res.json({ ok: true });
});

// Sends a push notification to every stored subscriber.
// Call this from routes/cars.js after a new car is successfully created.
// payload: { title, body, url } — url is where the notification click should take the user.
async function notifyAllSubscribers(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // not configured — silently skip

  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  if (!subs || subs.length === 0) return;

  const notificationPayload = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(pushSubscription, notificationPayload);
    } catch (err) {
      // 404/410 means the browser subscription is dead (user cleared data, uninstalled, etc.) — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      } else {
        console.error('Push send error for', sub.endpoint, err.statusCode, err.body);
      }
    }
  }));
}

module.exports = { router, notifyAllSubscribers };
