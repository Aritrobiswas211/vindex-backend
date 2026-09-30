// Sends email through Brevo's HTTP API (free: 300 emails/day).
// HTTP is used instead of SMTP because Render's free tier blocks SMTP ports.
async function sendMail({ to, toName, subject, html }) {
  if (!process.env.BREVO_API_KEY || !process.env.SENDER_EMAIL) {
    console.warn('Email skipped: BREVO_API_KEY / SENDER_EMAIL not set.');
    return false;
  }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'VINDEX Cars', email: process.env.SENDER_EMAIL },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  return true;
}

module.exports = { sendMail };
