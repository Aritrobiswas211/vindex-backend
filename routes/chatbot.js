const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Groq gives a free API key (no billing required). Get one at https://console.groq.com
// and set GROQ_API_KEY in your backend's environment variables (e.g. Render dashboard).
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Groq announced (June 17, 2026) that llama-3.3-70b-versatile is being deprecated and
// shut down by August 2026 — this is Groq's own recommended free-tier replacement.
const GROQ_MODEL = 'openai/gpt-oss-120b';

// Turns a car's per-fuel mileage object into compact text, e.g. "19kmpl/26km-kg(CNG)"
// for a multi-fuel car, or just "24.9kmpl" for a single-fuel one.
function formatMileageCompact(mileage, fuels) {
  const fuelList = Array.isArray(fuels) ? fuels : [];
  const parts = fuelList
    .filter(f => mileage && mileage[f])
    .map(f => `${mileage[f].value}${mileage[f].unit}${fuelList.length > 1 ? `(${f})` : ''}`);
  return parts.length ? parts.join('/') : 'n/a';
}

// One car per line, pipe-delimited, instead of JSON — no repeated {}/""/keys per
// car, which is what was pushing the prompt over Groq's free-tier token limit as
// the catalogue grew. includeProsCons can be dropped as a fallback if the
// inventory is still too large even in this compact form.
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

// Keeps the inventory block from ever growing large enough to blow the token
// budget again as the catalogue grows past 77 cars — degrades gracefully
// (drop pros/cons, then cap the car count) rather than failing outright.
const MAX_INVENTORY_CHARS = 10000;
function buildBoundedInventoryText(cars) {
  let text = buildInventoryText(cars, true);
  if (text.length <= MAX_INVENTORY_CHARS) return text;

  text = buildInventoryText(cars, false); // drop pros/cons first
  if (text.length <= MAX_INVENTORY_CHARS) return text;

  // Still too big — hard cap the number of cars shown as a last resort.
  const lines = text.split('\n');
  let kept = lines;
  while (kept.join('\n').length > MAX_INVENTORY_CHARS && kept.length > 1) {
    kept = kept.slice(0, Math.floor(kept.length * 0.8));
  }
  const omitted = lines.length - kept.length;
  return kept.join('\n') + (omitted > 0 ? `\n...and ${omitted} more cars not shown here (ask about one by name and I can still help).` : '');
}

function buildSystemPrompt(cars) {
  const inventoryText = buildBoundedInventoryText(cars || []);

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
- Language: always reply in the same language the visitor's most recent message is written in — English, Hindi, Hinglish, Tamil, Bengali, or any other language they use. Match their language naturally, the way a fluent local speaker would; keep car names, brand names, and numbers/prices as-is rather than translating them literally.

INVENTORY (one car per line: make model | price | body | fuel | transmission | seats | mileage | pros | cons):
${inventoryText}`;
}

// POST /api/chatbot/chat  — body: { messages: [{role:'user'|'assistant', content:'...'}] }
router.post('/chat', async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages.' });
  }
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'Chatbot is not configured on the server yet.' });
  }

  // Keep only the last 20 turns to control request size / latency.
  const trimmedHistory = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000)
  }));

  try {
    const { data: cars } = await supabase.from('cars').select('*');
    const systemPrompt = buildSystemPrompt(cars);
    const payload = {
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...trimmedHistory],
      temperature: 0.6,
      max_tokens: 500
    };

    let groqRes = await callGroq(payload);

    // One retry on rate limiting or a transient server hiccup — smooths over
    // brief blips instead of immediately telling the visitor it's down.
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

function callGroq(payload) {
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
}

module.exports = router;
