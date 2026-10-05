// Vercel serverless function: POST /api/ask  { question, entryIds }
// The browser does retrieval and sends only entry IDs; the FAQ text comes from this
// server-side copy, so the Groq key can't be used to answer arbitrary prompts.

import { ENTRIES, SYSTEM_PROMPT } from './_faq_entries.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MAX_QUESTION_CHARS = 500;
const MAX_ENTRIES = 4;
const RATE_LIMIT_PER_MIN = 10;

// Best-effort per-visitor limit. Serverless instances don't share memory, so this
// only slows down a single burst; Groq's own free-tier limits are the backstop.
const recent = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const times = (recent.get(ip) || []).filter(t => now - t < 60_000);
  const limited = times.length >= RATE_LIMIT_PER_MIN;
  if (!limited) times.push(now);
  recent.set(ip, times);
  return limited;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "You're asking questions very quickly. Please wait a minute and try again." });
  }

  const { question, entryIds } = req.body || {};
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Please type a question.' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({ error: `Please keep questions under ${MAX_QUESTION_CHARS} characters.` });
  }
  const entries = (Array.isArray(entryIds) ? entryIds : [])
    .slice(0, MAX_ENTRIES)
    .map(id => ENTRIES[id])
    .filter(Boolean);
  if (!entries.length) {
    return res.status(400).json({ error: 'No matching FAQ entries.' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'llm_unavailable' });
  }

  const context = entries.map((e, i) => `[FAQ ${i + 1}]\n${e.text}`).join('\n\n');
  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        // gpt-oss is a reasoning model: its thinking counts toward max_tokens, so keep effort low
        reasoning_effort: 'low',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `FAQ excerpts:\n\n${context}\n\nCustomer question: ${question.trim()}` },
        ],
      }),
    });
    if (!groqRes.ok) {
      console.error('Groq API error', groqRes.status, (await groqRes.text()).slice(0, 300));
      return res.status(502).json({ error: 'llm_unavailable' });
    }
    const data = await groqRes.json();
    const answer = (data.choices?.[0]?.message?.content || '').trim();
    if (!answer) return res.status(502).json({ error: 'llm_unavailable' });
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Groq request failed', err);
    return res.status(502).json({ error: 'llm_unavailable' });
  }
}
