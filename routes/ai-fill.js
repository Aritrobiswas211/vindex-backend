const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'openai/gpt-oss-120b'; // same free-tier model used by the chatbot

const VALID_BODY_TYPES = ['Hatchback', 'Sedan', 'SUV', 'MPV', 'Coupe'];
const VALID_FUEL = ['Petrol', 'Diesel', 'CNG', 'Electric'];
const VALID_TRANS = ['Manual', 'Automatic', 'AMT', 'CVT', 'DCT'];

function buildPrompt(make, model) {
  return `You are a car-data assistant for an Indian car advisory website. A user will give you a car's make and model. Respond with ONLY a single valid JSON object (no markdown fences, no commentary, no extra text) describing that car for the Indian market, in exactly this shape:

{
  "make": "string",
  "model": "string",
  "body": "one of: ${VALID_BODY_TYPES.join(', ')}",
  "seats": number,
  "mileage": number (kmpl for petrol/diesel/CNG, or km range for Electric — just the number),
  "unit": "kmpl" or "km/charge",
  "fuel": ["array, any of: ${VALID_FUEL.join(', ')}"],
  "trans": ["array, any of: ${VALID_TRANS.join(', ')}"],
  "pros": ["3-5 short real strengths of this car"],
  "cons": ["3-5 short real weaknesses of this car"],
  "variants": [
    { "name": "variant name e.g. LXI", "price": number (in INR lakhs, e.g. 6.5), "features": ["4-8 short features specific to this variant, e.g. Touchscreen infotainment, Rear parking sensors, Alloy wheels"] }
  ]
}

Use your real knowledge of this car's actual variant lineup, approximate ex-showroom pricing in India (in lakhs), and typical features per variant, ordered from cheapest to most expensive. If you're not confident about exact current pricing, give your best reasonable estimate rather than refusing — the admin will review and correct anything before publishing. Only output the JSON object, nothing else.

Car: ${make} ${model}`;
}

// Strips markdown code fences if the model wraps its JSON in them despite instructions.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function sanitizeResult(raw, fallbackMake, fallbackModel) {
  const fuel = Array.isArray(raw.fuel) ? raw.fuel.filter(f => VALID_FUEL.includes(f)) : [];
  const trans = Array.isArray(raw.trans) ? raw.trans.filter(t => VALID_TRANS.includes(t)) : [];
  const variants = Array.isArray(raw.variants) ? raw.variants
    .filter(v => v && typeof v.name === 'string' && !isNaN(Number(v.price)))
    .map(v => ({
      name: v.name.trim(),
      price: Number(v.price),
      features: Array.isArray(v.features) ? v.features.filter(f => typeof f === 'string').slice(0, 10) : []
    })) : [];

  return {
    make: (raw.make || fallbackMake || '').trim(),
    model: (raw.model || fallbackModel || '').trim(),
    body: VALID_BODY_TYPES.includes(raw.body) ? raw.body : 'Hatchback',
    seats: Number.isFinite(Number(raw.seats)) ? Number(raw.seats) : 5,
    mileage: Number.isFinite(Number(raw.mileage)) ? Number(raw.mileage) : 0,
    unit: raw.unit === 'km/charge' ? 'km/charge' : 'kmpl',
    fuel: fuel.length ? fuel : ['Petrol'],
    trans: trans.length ? trans : ['Manual'],
    pros: Array.isArray(raw.pros) ? raw.pros.filter(p => typeof p === 'string').slice(0, 6) : [],
    cons: Array.isArray(raw.cons) ? raw.cons.filter(c => typeof c === 'string').slice(0, 6) : [],
    variants
  };
}

// POST /api/admin/ai-fill-car — body: { make, model }
router.post('/ai-fill-car', async (req, res) => {
  const { make, model } = req.body || {};
  if (!make || !make.trim()) return res.status(400).json({ error: 'Enter at least a make (e.g. "Tata").' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'AI fill is not configured on the server yet (missing GROQ_API_KEY).' });

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: buildPrompt(make.trim(), (model || '').trim()) }],
        temperature: 0.4,
        max_tokens: 1500
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('AI fill Groq error:', groqRes.status, errText);
      return res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again.' });
    }

    const data = await groqRes.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'The AI did not return any data. Please try again.' });

    let parsed;
    try {
      parsed = extractJson(content);
    } catch (parseErr) {
      console.error('AI fill JSON parse error:', parseErr.message, content);
      return res.status(502).json({ error: "Couldn't understand the AI's response. Please try again." });
    }

    const result = sanitizeResult(parsed, make, model);
    res.json({ car: result, note: 'AI-generated — please double-check pricing and specs before saving.' });
  } catch (err) {
    console.error('ai-fill-car error:', err);
    res.status(500).json({ error: 'Something went wrong generating this car\'s data.' });
  }
});

module.exports = router;
