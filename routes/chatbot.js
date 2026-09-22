const express = require('express');
const supabase = require('../db');

const router = express.Router();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'openai/gpt-oss-120b';
// Groq's free tier for Whisper: 2,000 requests/day, up to 25MB per file —
// generous enough for voice chat, and works in every browser (unlike the
// browser's built-in SpeechRecognition, which Firefox doesn't support at all).
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

function formatMileageCompact(mileage, fuels) {
  const fuelList = Array.isArray(fuels) ? fuels : [];
  const parts = fuelList
    .filter(f => mileage && mileage[f])
    .map(f => `${mileage[f].value}${mileage[f].unit}${fuelList.length > 1 ? `(${f})` : ''}`);
  return parts.length ? parts.join('/') : 'n/a';
}

function buildInventoryText(cars, includeProsCons) {
  return (cars || []).map(c => {
    const fuel = Array.isArray(c.fuel) ? c.fuel.join('/') : '';
    const trans = Array.isArray(c.trans) ? c.trans.join('/') : (c.trans || '');
    const base = `${c.make} ${c.model} | ₹${c.price}L | ${c.body} | ${fuel} | ${trans} | ${c.seats}s | ${formatMileageCompact(c.mileage, c.fuel)}`;
    if (!includeProsCons) return base;
    const pros = Array.isArray(c.pros) ? c.pros.slice(0, 2).join('; ') : '';
    const cons = Array.isArray(c.cons) ? c.cons.slice(0, 2).join('; ') : '';
    return `${base} | +${pros} | -${cons}`;
  }).join('\n');
}

const MAX_INVENTORY_CHARS = 10000;
function buildBoundedInventoryText(cars) {
  let text = buildInventoryText(cars, true);
  if (text.length <= MAX_INVENTORY_CHARS) return text;
  text = buildInventoryText(cars, false);
  if (text.length <= MAX_INVENTORY_CHARS) return text;
  const lines = text.split('\n');
  let kept = lines;
  while (kept.join('\n').length > MAX_INVENTORY_CHARS && kept.length > 1) {
    kept = kept.slice(0, Math.floor(kept.length * 0.8));
  }
  const omitted = lines.length - kept.length;
  return kept.join('\n') + (omitted > 0 ? `\n...and ${omitted} more cars not shown here (ask about one by name and I can still help).` : '');
}

// Voice commands ("show me SUVs under 10 lakhs") need the model to emit a
// machine-readable action alongside its normal reply. Rather than a second
// API call, we ask for one optional tag at the very start of the reply,
// which the frontend strips out before displaying/speaking the rest.
function buildActionRules() {
  return `
VOICE / SITE CONTROL:
If — and only if — the visitor is clearly asking to browse, filter, or navigate the site (e.g. "show me SUVs under 10 lakhs", "take me to the wishlist", "filter by diesel automatics", "start the quiz"), prefix your reply with exactly one action tag on its own line, then continue with your normal short spoken reply below it:

[ACTION:{"type":"filter","brand":"","fuel":"","trans":"","body":"","maxPrice":45}]
or
[ACTION:{"type":"navigate","view":"home|browse|compareView|wishlist|calculators"}]
or
[ACTION:{"type":"quiz"}]

Rules for the filter action: only include keys the visitor actually specified; omit brand/fuel/trans/body entirely rather than guessing (empty string means "show all" — don't set it unless asked). Valid fuel: Petrol, Diesel, CNG, Electric. Valid trans: Manual, Automatic, AMT, CVT, DCT. Valid body: Hatchback, Sedan, SUV, MPV, Coupe. maxPrice is in lakhs. Use exact brand names as they appear in the inventory below.
Do NOT include an action tag for ordinary questions, comparisons, or advice — only for explicit browse/filter/navigate requests.`;
}

function buildSystemPrompt(cars, language) {
  const inventoryText = buildBoundedInventoryText(cars || []);
  const languageRule = language
    ? `- The visitor has explicitly chosen to chat in: ${language}. Always reply in ${language}, regardless of what language their message is typed in — do not switch languages based on their wording. Keep car names, brand names, and numbers/prices as-is rather than translating them literally.`
    : `- Language: always reply in the same language the visitor's most recent message is written in — English, Hindi, Hinglish, Tamil, Bengali, or any other language they use. Match their language naturally, the way a fluent local speaker would; keep car names, brand names, and numbers/prices as-is rather than translating them literally.`;

  return `You are the "Vindex Assistant" — a friendly, concise car-advisory chatbot embedded on the Vindex car recommendation website.

You help visitors:
- Find cars that fit their budget, family size, fuel preference, or use case
- Compare specific cars they mention
- Explain trade-offs (fuel type, body style, running costs) in plain language
- Answer general questions about the site (quiz, wishlist, compare tool)

Rules:
- Only recommend cars from the INVENTORY list below — never invent cars or specs that aren't in it.
- Prices are in INR lakhs (1 lakh = 100,000 INR).
- Keep replies short and conversational (2-5 sentences, or a short bullet list for comparisons/multiple picks). Avoid long essays.
- If nothing in the inventory fits, say so honestly instead of forcing a recommendation.
- If asked something totally unrelated to cars or this site, gently redirect back to how you can help with car buying decisions.
- Plain text only — this chat window does not render markdown. Never use **bold**, _italics_, #headings, or [links](url); asterisks and underscores will show up as literal characters to the visitor. For lists, just start a line with "-" and a space.
${languageRule}
${buildActionRules()}

INVENTORY (one car per line: make model | price | body | fuel | transmission | seats | mileage | pros | cons):
${inventoryText}`;
}

function callGroq(payload) {
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify(payload)
  });
}

// POST /api/chatbot/chat
router.post('/chat', async (req, res) => {
  const { messages, language } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages.' });
  }
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Chatbot is not configured on the server yet.' });
  }

  const trimmedHistory = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));

  try {
    const { data: cars } = await supabase.from('cars').select('*');
    const systemPrompt = buildSystemPrompt(cars, language);
    const payload = {
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...trimmedHistory],
      temperature: 0.6,
      max_tokens: 500
    };

    let groqRes = await callGroq(payload);
    if (!groqRes.ok && (groqRes.status === 429 || groqRes.status >= 500)) {
      await new Promise(r => setTimeout(r, 800));
      groqRes = await callGroq(payload);
    }

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      const friendly = groqRes.status === 429 || groqRes.status === 413
        ? "I'm getting a lot of requests right now — please try again in a few seconds."
        : 'The assistant is temporarily unavailable. Please try again.';
      return res.status(502).json({ error: friendly });
    }

    const data = await groqRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: 'The assistant had trouble responding. Please try again.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('Chatbot route error:', err);
    res.status(500).json({ error: 'Something went wrong reaching the assistant.' });
  }
});

// POST /api/chatbot/transcribe — body: raw audio bytes (Content-Type: audio/webm or similar)
// Query param ?language=hi|ta|bn|en (optional hint, improves accuracy).
// Uses Groq's free Whisper endpoint — no new npm dependency needed since
// Node 18+ has FormData/Blob built in, so we build the multipart body ourselves.
router.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Voice transcription is not configured on the server yet.' });
  }
  const audioBuffer = req.body;
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return res.status(400).json({ error: 'No audio received.' });
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/webm' }), 'audio.webm');
    form.append('model', GROQ_WHISPER_MODEL);
    if (req.query.language) form.append('language', String(req.query.language));

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Groq transcription error:', resp.status, errText);
      return res.status(502).json({ error: 'Could not transcribe audio. Please try again.' });
    }

    const data = await resp.json();
    res.json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error('Transcribe route error:', err);
    res.status(500).json({ error: 'Something went wrong transcribing that.' });
  }
});

// Groq's free TTS tier is tightly capped (short per-request text, low daily
// volume) and English/Arabic-only — so this is a best-effort upgrade the
// frontend tries for short English/Hinglish replies, falling back to the
// browser's own speech synthesis on any error, quota limit, or unsupported
// language (Hindi/Tamil/Bengali always use the browser voice).
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_TTS_VOICE = 'hannah';

// POST /api/chatbot/speak — body: { text }
router.post('/speak', async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Not configured.' });
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text.' });
  const clipped = text.slice(0, 180); // stay well inside the free tier's per-request cap

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_TTS_MODEL, voice: GROQ_TTS_VOICE, input: clipped, response_format: 'mp3' }),
    });
    if (!resp.ok) {
      // Expected fairly often given the tight free-tier quota — not logged
      // as an error, the frontend silently falls back to browser speech.
      return res.status(502).json({ error: 'TTS unavailable right now.' });
    }
    const arrayBuffer = await resp.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).json({ error: 'TTS failed.' });
  }
});

module.exports = router;
