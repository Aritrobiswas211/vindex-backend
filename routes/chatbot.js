const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Groq gives a free API key (no billing required). Get one at https://console.groq.com
// and set GROQ_API_KEY in your backend's environment variables (e.g. Render dashboard).
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // free tier model on Groq

function buildSystemPrompt(cars) {
  // Trim each car down to only what the assistant needs, to keep the
  // request small and fast.
  const compactCars = (cars || []).map(c => ({
    make: c.make, model: c.model, price_lakh: c.price, body: c.body,
    fuel: c.fuel, trans: c.trans, seats: c.seats,
    mileage: c.mileage, unit: c.unit,
    pros: c.pros, cons: c.cons
  }));

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

INVENTORY (JSON):
${JSON.stringify(compactCars)}`;
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

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...trimmedHistory],
        temperature: 0.6,
        max_tokens: 400
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
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

module.exports = router;
