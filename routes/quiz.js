const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Gemini's free tier (Google AI Studio) has no cost and no card required —
// unlike the Anthropic API, which only offers a small expiring trial credit.
// Override with GEMINI_MODEL in .env if you want to try a different model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function transArr(t) { return Array.isArray(t) ? t : (t ? [t] : []); }

function usageBodyPreference(usage) {
  return {
    city: ['Hatchback', 'Sedan'], highway: ['Sedan', 'SUV'], mixed: ['SUV', 'MPV'], offroad: ['SUV'],
  }[usage] || [];
}

// Transparent, explainable score — used to shortlist candidates before
// handing them to the AI (keeps the prompt small and grounded in real
// inventory) and as the fallback ranking if the AI call fails.
function scoreCar(c, { budget, usage, family, fuel }) {
  let score = 0;
  if (c.price <= budget) score += 40; else score += Math.max(0, 40 - (c.price - budget) * 5);
  if (c.seats >= family) score += 20; else score -= 12;
  if (fuel === 'any' || (c.fuel || []).includes(fuel)) score += 25;
  if (usageBodyPreference(usage).includes(c.body)) score += 15; else score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fallbackReason(c, { budget, family, fuel }) {
  const bits = [];
  if (c.price <= budget) bits.push('within budget');
  if (c.seats >= family) bits.push('fits your group');
  if (fuel !== 'any' && (c.fuel || []).includes(fuel)) bits.push('preferred fuel');
  return bits.length
    ? `Rule-based match — ${bits.join(', ')}.`
    : 'Closest overall fit from our catalogue based on your answers.';
}

function buildPrompt(shortlist, { budget, usage, family, fuel }) {
  const catalogue = shortlist.map(c => (
    `id:${c.id} | ${c.make} ${c.model} | price: \u20b9${c.price}L | fuel: ${(c.fuel || []).join('/')} | ` +
    `transmission: ${transArr(c.trans).join('/')} | body: ${c.body} | seats: ${c.seats} | ` +
    `mileage: ${c.mileage} ${c.unit} | pros: ${(c.pros || []).join('; ')} | cons: ${(c.cons || []).join('; ')}`
  )).join('\n');

  return `You are a car-buying advisor for VINDEX, a car advisory site for Indian car buyers.

A user answered a short quiz:
- Budget: up to \u20b9${budget} Lakhs (on-road)
- Primary use: ${usage}
- People who usually ride along: ${family}
- Fuel preference: ${fuel === 'any' ? 'no strong preference' : fuel}

Here is a shortlist of real cars from our catalogue (only recommend from this list, referencing the exact "id" field):
${catalogue}

Pick the 1 or 2 cars from this shortlist that are the best genuine fit for this specific person. Don't just default to the top-scoring car by price/seats — use the pros/cons to reason about real trade-offs relevant to their answers (city driving favors easy parking and mileage; a highway commuter cares about cruising comfort; a big family needs a genuinely usable extra row, not just a raw seat count). Only include a second pick if it is a meaningfully different, also-strong alternative (e.g. notably cheaper, or a different body style) — don't pad to two picks if there's one clear winner.

Respond with ONLY raw JSON (no markdown fences, no preamble, no explanation outside the JSON), in exactly this shape:
{"picks":[{"id": <number>, "headline": "<5-8 word headline>", "reason": "<2-3 sentence explanation in a warm, direct, non-salesy tone, referencing specific facts about the car and how it matches their answers>"}]}`;
}

router.post('/recommend', async (req, res) => {
  const { budget, usage, family, fuel } = req.body || {};
  const b = Number(budget), fam = Number(family);
  if (!b || !usage || !fam || !fuel) {
    return res.status(400).json({ error: 'Missing quiz answers.' });
  }

  const { data: cars, error } = await supabase.from('cars').select('*');
  if (error || !cars || !cars.length) {
    return res.status(500).json({ error: 'Could not load the car catalogue.' });
  }

  const quiz = { budget: b, usage, family: fam, fuel };
  const ranked = cars
    .map(c => ({
      ...c,
      fuel: Array.isArray(c.fuel) ? c.fuel : [],
      trans: transArr(c.trans),
      score: scoreCar(c, quiz),
    }))
    .sort((x, y) => y.score - x.score);

  const shortlist = ranked.slice(0, 10);
  const fallbackPicks = () => shortlist.slice(0, 2).map(c => ({
    id: c.id, make: c.make, model: c.model, price: c.price, fuel: c.fuel, trans: c.trans,
    body: c.body, seats: c.seats, mileage: c.mileage, unit: c.unit, image: c.image,
    pros: c.pros || [], cons: c.cons || [],
    headline: c.score >= 75 ? 'Strong overall match' : 'Closest available fit',
    reason: fallbackReason(c, quiz),
  }));

  if (!process.env.GEMINI_API_KEY) {
    return res.json({ picks: fallbackPicks(), aiPowered: false });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const aiRes = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(shortlist, quiz) }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }).finally(() => clearTimeout(timeout));

    if (!aiRes.ok) throw new Error(`Gemini API responded ${aiRes.status}`);
    const data = await aiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    if (!Array.isArray(parsed.picks) || !parsed.picks.length) throw new Error('No picks in AI response.');

    const picks = parsed.picks
      .slice(0, 2)
      .map(p => {
        const c = shortlist.find(car => car.id === p.id);
        if (!c) return null;
        return {
          id: c.id, make: c.make, model: c.model, price: c.price, fuel: c.fuel, trans: c.trans,
          body: c.body, seats: c.seats, mileage: c.mileage, unit: c.unit, image: c.image,
          pros: c.pros || [], cons: c.cons || [],
          headline: String(p.headline || '').slice(0, 80),
          reason: String(p.reason || '').slice(0, 500),
        };
      })
      .filter(Boolean);

    if (!picks.length) throw new Error('AI picks did not match the shortlist.');

    res.json({ picks, aiPowered: true });
  } catch (err) {
    console.error('Quiz AI recommendation failed, falling back to rule-based match:', err.message);
    res.json({ picks: fallbackPicks(), aiPowered: false });
  }
});

module.exports = router;
