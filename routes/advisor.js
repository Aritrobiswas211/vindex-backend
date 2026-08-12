const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Free tier: create a key at https://aistudio.google.com/apikey (no card required)
// and put it in .env as GEMINI_API_KEY. If it's missing or the call fails for any
// reason, this route silently falls back to the deterministic rule-based picks
// below — the quiz always returns a result either way.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function toPublic(row) {
  return {
    id: row.id,
    make: row.make,
    model: row.model,
    price: row.price,
    fuel: Array.isArray(row.fuel) ? row.fuel : [],
    trans: row.trans,
    body: row.body,
    seats: row.seats,
    mileage: row.mileage,
    unit: row.unit,
    pros: Array.isArray(row.pros) ? row.pros : [],
    cons: Array.isArray(row.cons) ? row.cons : [],
  };
}

// Same weighting the old client-side quiz used to sort cars. Used both to
// build the shortlist handed to the AI (so it isn't reasoning over all 70+
// cars) and as the deterministic fallback if the AI is unavailable.
function ruleScore(c, { budget, usage, familyNum, fuel }) {
  const usageBodyMap = {
    city: ['Hatchback', 'Sedan'],
    highway: ['Sedan', 'SUV'],
    mixed: ['SUV', 'MPV'],
    offroad: ['SUV'],
  };
  let score = 0;
  if (c.price <= budget) score += 40; else score += Math.max(0, 40 - (c.price - budget) * 5);
  if (c.seats >= familyNum) score += 20; else score -= 12;
  if (fuel === 'any' || c.fuel.includes(fuel)) score += 25;
  if (usageBodyMap[usage] && usageBodyMap[usage].includes(c.body)) score += 15; else score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fallbackReason(c, { budget, usage, familyNum, fuel }) {
  const bits = [];
  if (c.price <= budget) bits.push('fits your budget');
  if (c.seats >= familyNum) bits.push('seats your group');
  if (fuel !== 'any' && c.fuel.includes(fuel)) bits.push('matches your fuel preference');
  return bits.length ? `Matches on ${bits.join(', ')}.` : 'Closest overall fit among what is available.';
}

async function askGemini({ shortlist, budget, usage, familyNum, fuel, notes }) {
  const candidateText = shortlist
    .map(
      (c) =>
        `id:${c.id} | ${c.make} ${c.model} | ₹${c.price}L | ${c.body} | seats ${c.seats} | fuel ${c.fuel.join('/')} | ${c.trans} | ${c.mileage} ${c.unit} | pros: ${c.pros.join('; ')} | cons: ${c.cons.join('; ')}`
    )
    .join('\n');

  const prompt = `You are a car-buying advisor for the Indian market. A user answered a short quiz:
- Budget: up to ₹${budget}L
- Driving pattern: ${usage}
- People usually riding along: ${familyNum}
- Fuel preference: ${fuel === 'any' ? 'no preference' : fuel}
${notes ? `- Extra notes from the user: "${String(notes).slice(0, 400)}"` : '- Extra notes from the user: (none given)'}

Here is a shortlist of real cars to choose from, one per line (id | make model | price | body | seats | fuel | transmission | mileage | pros | cons):
${candidateText}

Pick the ONE car from this list that best fits this user, weighing their notes as much as the structured answers. Only include a SECOND car if it is a genuinely different, comparably good option worth showing (e.g. a different body style or fuel type that also fits well) — otherwise return just one pick.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"picks":[{"id": <number from the list above>, "headline": "<4-6 word headline>", "reason": "<1-2 sentences, specific, referencing their actual answers/notes and this car's real pros or cons>"}]}`;

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
    }),
  });

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
  const json = await resp.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.picks)) return null;

  return parsed.picks
    .filter((p) => p && (typeof p.id === 'number' || !isNaN(parseInt(p.id, 10))))
    .map((p) => ({
      id: parseInt(p.id, 10),
      headline: String(p.headline || '').slice(0, 80),
      reason: String(p.reason || '').slice(0, 320),
    }));
}

// POST /api/advisor/quiz — public. Body: { budget, usage, family, fuel, notes? }
router.post('/quiz', async (req, res) => {
  const { budget, usage, family, fuel, notes } = req.body || {};
  const budgetNum = parseInt(budget, 10);
  const familyNum = parseInt(family, 10);

  if (!budgetNum || !usage || !familyNum || !fuel) {
    return res.status(400).json({ error: 'Missing quiz answers.' });
  }

  const { data, error } = await supabase.from('cars').select('*');
  if (error) return res.status(500).json({ error: 'Could not load cars.' });
  const cars = data.map(toPublic);

  const ctx = { budget: budgetNum, usage, familyNum, fuel };
  const scored = cars
    .map((c) => ({ ...c, score: ruleScore(c, ctx) }))
    .sort((a, b) => b.score - a.score);

  const shortlist = scored.slice(0, 10); // candidate pool handed to the AI
  const fallbackPicks = scored.slice(0, 2).map((c) => ({
    id: c.id,
    score: c.score,
    headline: c.score >= 70 ? 'Strong overall match' : 'Closest fit available',
    reason: fallbackReason(c, ctx),
  }));

  if (!GEMINI_API_KEY) {
    return res.json({ picks: fallbackPicks, source: 'rules' });
  }

  try {
    const aiPicks = await askGemini({ shortlist, ...ctx, notes });
    if (aiPicks && aiPicks.length) {
      const withScores = aiPicks
        .map((p) => {
          const match = shortlist.find((c) => c.id === p.id);
          return match ? { id: p.id, score: match.score, headline: p.headline, reason: p.reason } : null;
        })
        .filter(Boolean);
      if (withScores.length) {
        return res.json({ picks: withScores.slice(0, 2), source: 'ai' });
      }
    }
    return res.json({ picks: fallbackPicks, source: 'rules' });
  } catch (err) {
    console.error('Gemini advisor error:', err.message);
    return res.json({ picks: fallbackPicks, source: 'rules' });
  }
});

module.exports = router;
