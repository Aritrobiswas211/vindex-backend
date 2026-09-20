const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Free tier: create a key at https://aistudio.google.com/apikey (no card required)
// and put it in .env as GEMINI_API_KEY. If it's missing or the call fails for any
// reason, this route silently falls back to the deterministic rule-based picks
// below — the quiz always returns a result either way.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest';
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
    // mileage is one entry per fuel type, e.g. {Petrol:{value:19,unit:"kmpl"}, CNG:{value:26,unit:"km/kg"}}
    mileage: (row.mileage && typeof row.mileage === 'object' && !Array.isArray(row.mileage)) ? row.mileage : {},
    pros: Array.isArray(row.pros) ? row.pros : [],
    cons: Array.isArray(row.cons) ? row.cons : [],
  };
}

// Turns a car's per-fuel mileage object into readable text for the AI prompt,
// e.g. "19 kmpl (Petrol) / 26 km/kg (CNG)" or just "24.9 kmpl" for single-fuel cars.
function formatMileage(mileage, fuels) {
  const fuelList = Array.isArray(fuels) ? fuels : [];
  const parts = fuelList
    .filter(f => mileage && mileage[f])
    .map(f => `${mileage[f].value} ${mileage[f].unit}${fuelList.length > 1 ? ` (${f})` : ''}`);
  return parts.length ? parts.join(' / ') : 'n/a';
}

// Same weighting the old client-side quiz used to sort cars. Used both to
// build the shortlist handed to the AI (so it isn't reasoning over all 70+
// cars) and as the deterministic fallback if the AI is unavailable.
function ruleScore(c, { budget, usage, familyNum, fuel, brand }) {
  const usageBodyMap = {
    city: ['Hatchback', 'Sedan'],
    highway: ['Sedan', 'SUV'],
    mixed: ['SUV', 'MPV'],
    offroad: ['SUV'],
  };
  const wantsBrand = brand && brand !== 'any';
  let score = 0;
  if (c.price <= budget) score += 35; else score += Math.max(0, 35 - (c.price - budget) * 5);
  if (c.seats >= familyNum) score += 18; else score -= 10;
  if (fuel === 'any' || c.fuel.includes(fuel)) score += 22;
  if (usageBodyMap[usage] && usageBodyMap[usage].includes(c.body)) score += 13; else score += 3;
  if (wantsBrand && c.make.toLowerCase() === String(brand).toLowerCase()) score += 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fallbackReason(c, { budget, usage, familyNum, fuel, brand }) {
  const bits = [];
  if (c.price <= budget) bits.push('fits your budget');
  if (c.seats >= familyNum) bits.push('seats your group');
  if (fuel !== 'any' && c.fuel.includes(fuel)) bits.push('matches your fuel preference');
  if (brand && brand !== 'any' && c.make.toLowerCase() === String(brand).toLowerCase()) bits.push('is your preferred brand');
  return bits.length ? `Matches on ${bits.join(', ')}.` : 'Closest overall fit among what is available.';
}

async function askGemini({ shortlist, budget, usage, familyNum, fuel, brand, notes }) {
  const candidateText = shortlist
    .map(
      (c) =>
        `id:${c.id} | ${c.make} ${c.model} | ₹${c.price}L | ${c.body} | seats ${c.seats} | fuel ${c.fuel.join('/')} | ${c.trans} | ${formatMileage(c.mileage, c.fuel)} | pros: ${c.pros.join('; ')} | cons: ${c.cons.join('; ')}`
    )
    .join('\n');

  const wantsBrand = brand && brand !== 'any';

  const prompt = `You are a car-buying advisor for the Indian market. A user answered a short quiz:
- Budget: up to ₹${budget}L
- Driving pattern: ${usage}
- People usually riding along: ${familyNum}
- Fuel preference: ${fuel === 'any' ? 'no preference' : fuel}
- Brand preference: ${wantsBrand ? brand : 'no preference'}
${notes ? `- Extra notes from the user: "${String(notes).slice(0, 400)}"` : '- Extra notes from the user: (none given)'}

Here is a shortlist of real cars to choose from, one per line (id | make model | price | body | seats | fuel | transmission | mileage | pros | cons):
${candidateText}

Pick the ONE car from this list that best fits this user, weighing their notes as much as the structured answers.${wantsBrand ? ` The user asked for ${brand} specifically — strongly prefer a ${brand} car from the shortlist above if one is a reasonable fit, and only pick a different brand if no ${brand} car in the list comes close to fitting their budget, seats, or fuel needs (say so plainly in the reason if you do).` : ''} Only include a SECOND car if it is a genuinely different, comparably good option worth showing (e.g. a different body style or fuel type that also fits well) — otherwise return just one pick.

Respond with ONLY valid JSON, no markdown fences, no commentary, no text before or after the JSON object, in exactly this shape:
{"picks":[{"id": <number from the list above>, "headline": "<4-6 word headline>", "reason": "<1-2 sentences, specific, referencing their actual answers/notes and this car's real pros or cons>"}]}`;

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048, // generous headroom — this model spends some tokens on internal "thinking" before the visible answer
      },
    }),
  });

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
  const json = await resp.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) {
    throw new Error(`Gemini returned empty text (finishReason: ${json.candidates?.[0]?.finishReason || 'unknown'})`);
  }
  // The model is asked to return only JSON, but sometimes wraps it in
  // markdown fences or a stray sentence — pull out just the {...} object.
  const stripped = text.replace(/```json|```/g, '').trim();
  const jsonStart = stripped.indexOf('{');
  const jsonEnd = stripped.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`No JSON object found in Gemini response: ${stripped.slice(0, 200)}`);
  }
  const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));
  if (!Array.isArray(parsed.picks)) return null;

  return parsed.picks
    .filter((p) => p && (typeof p.id === 'number' || !isNaN(parseInt(p.id, 10))))
    .map((p) => ({
      id: parseInt(p.id, 10),
      headline: String(p.headline || '').slice(0, 80),
      reason: String(p.reason || '').slice(0, 320),
    }));
}

// POST /api/advisor/quiz — public. Body: { budget, usage, family, fuel, brand?, notes? }
router.post('/quiz', async (req, res) => {
  const { budget, usage, family, fuel, brand, notes } = req.body || {};
  const budgetNum = parseInt(budget, 10);
  const familyNum = parseInt(family, 10);

  if (!budgetNum || !usage || !familyNum || !fuel) {
    return res.status(400).json({ error: 'Missing quiz answers.' });
  }

  const { data, error } = await supabase.from('cars').select('*');
  if (error) return res.status(500).json({ error: 'Could not load cars.' });
  const allCars = data.map(toPublic);

  // If the user asked for a specific brand, score within that brand's
  // lineup only — this is what actually makes the pick precise. Only fall
  // back to the full catalogue if that brand isn't in the data at all, so
  // the quiz never dead-ends on an empty result.
  const wantsBrand = brand && brand !== 'any';
  const brandCars = wantsBrand
    ? allCars.filter((c) => c.make.toLowerCase() === String(brand).toLowerCase())
    : [];
  const cars = brandCars.length ? brandCars : allCars;

  const ctx = { budget: budgetNum, usage, familyNum, fuel, brand };
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
