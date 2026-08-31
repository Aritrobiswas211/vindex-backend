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
  return `You are a car-data assistant for an Indian car advisory website. A user will give you a car's make and model. Respond with ONLY a single valid JSON object — no markdown fences, no commentary, no text before or after the JSON — describing that car for the Indian market, in exactly this shape:

{
  "make": "string",
  "model": "string",
  "body": "one of: ${VALID_BODY_TYPES.join(', ')}",
  "seats": number,
  "mileage": number (kmpl for petrol/diesel/CNG, or km range for Electric — just the number),
  "unit": "kmpl" or "km/charge",
  "fuel": ["array, any of: ${VALID_FUEL.join(', ')}"],
  "trans": ["array, any of: ${VALID_TRANS.join(', ')}"],
  "pros": ["3-4 short real strengths of this car"],
  "cons": ["3-4 short real weaknesses of this car"],
  "variants": [
    { "name": "variant name e.g. LXI", "price": number (in INR lakhs, e.g. 6.5), "features": ["3-5 short features specific to this variant"] }
  ]
}

Use your real knowledge of this car's actual variant lineup, approximate ex-showroom pricing in India (in lakhs), and typical features per variant, ordered from cheapest to most expensive. Limit yourself to at most 4 variants — pick the most representative ones (e.g. base, mid, top) rather than every trim that exists. If you're not confident about exact current pricing, give your best reasonable estimate rather than refusing — the admin will review and correct anything before publishing.

Keep the whole response compact and complete — it is critical that the JSON object is fully closed with no missing brackets, since it will be parsed by a machine. Only output the JSON object, nothing else.

Car: ${make} ${model}`;
}

// Pulls the JSON object out of the model's reply. Rather than naively grabbing
// from the first "{" to the last "}" (which breaks if the model added any
// trailing text, or if the response got cut off before the outermost object
// actually closed), this walks the string counting brace depth so it finds
// the exact span of the first complete top-level object.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in AI response.');

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  // Depth never returned to 0 — the response was cut off before the object closed.
  throw new Error('AI response was cut off before the JSON object finished.');
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

function callGroq(prompt, maxTokens) {
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens
    })
  });
}

// POST /api/admin/ai-fill-car — body: { make, model }
router.post('/ai-fill-car', async (req, res) => {
  const { make, model } = req.body || {};
  if (!make || !make.trim()) return res.status(400).json({ error: 'Enter at least a make (e.g. "Tata").' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'AI fill is not configured on the server yet (missing GROQ_API_KEY).' });

  const prompt = buildPrompt(make.trim(), (model || '').trim());

  try {
    // 2500 tokens gives real headroom for a 4-variant car with full feature
    // lists — the old 1500 limit was cutting responses off mid-object for
    // anything with more than a couple of variants, which is what was
    // producing "Couldn't understand the AI's response".
    let groqRes = await callGroq(prompt, 2500);

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('AI fill Groq error:', groqRes.status, errText);
      return res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again.' });
    }

    let data = await groqRes.json();
    let content = data?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'The AI did not return any data. Please try again.' });

    let parsed;
    try {
      parsed = extractJson(content);
    } catch (parseErr) {
      // One retry with an even higher token ceiling — covers the case where
      // the first attempt was genuinely truncated rather than malformed.
      console.warn('AI fill: first attempt failed to parse, retrying with more headroom:', parseErr.message);
      try {
        groqRes = await callGroq(prompt, 4000);
        if (!groqRes.ok) throw new Error(`Groq HTTP ${groqRes.status}`);
        data = await groqRes.json();
        content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty content on retry.');
        parsed = extractJson(content);
      } catch (retryErr) {
        console.error('AI fill JSON parse error (after retry):', retryErr.message, content);
        return res.status(502).json({ error: "Couldn't understand the AI's response after retrying. Please try again, or fill this car in manually." });
      }
    }

    const result = sanitizeResult(parsed, make, model);
    res.json({ car: result, note: 'AI-generated — please double-check pricing and specs before saving.' });
  } catch (err) {
    console.error('ai-fill-car error:', err);
    res.status(500).json({ error: 'Something went wrong generating this car\'s data.' });
  }
});

module.exports = router;
