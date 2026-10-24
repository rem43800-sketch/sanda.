import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.post('/api/ai', async (req, res) => {
  const { prompt, schema } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'اكتب وصفًا واضحًا أولًا.' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'نواجه مشكلة مؤقتة في إنشاء النتيجة. يرجى المحاولة لاحقًا.' });
  }

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const requestBody = JSON.stringify({
      systemInstruction: {
        parts: [{ text: `أنت مساعد منصة سَندَ العربية. أجب باللغة التي يطلبها المستخدم، والعربية افتراضيًا. أعد JSON صالحًا فقط دون Markdown. البنية المطلوبة: ${schema || 'JSON مناسب للمهمة'}` }]
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 4096 }
    });

    // Keep the demo responsive: fail fast instead of leaving the user waiting indefinitely.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);
    let response;
    let data = {};
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal
      });
      data = await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      console.error('Gemini API error:', response.status, data?.error?.message || 'unknown');
      return res.status(502).json({ error: 'نواجه مشكلة مؤقتة في إنشاء النتيجة. يرجى المحاولة لاحقًا.' });
    }

    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('\n').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    try {
      return res.json({ result: JSON.parse(raw) });
    } catch {
      return res.status(502).json({ error: 'لم نتمكن من تجهيز النتيجة هذه المرة. جرّب مرة أخرى.' });
    }
  } catch (err) {
    console.error('Gemini request failed:', err?.message || 'unknown');
    return res.status(502).json({ error: 'نواجه مشكلة مؤقتة في إنشاء النتيجة. يرجى المحاولة لاحقًا.' });
  }
});

const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), err => { if (err) next(); });
});
app.listen(PORT, () => console.log(`SANDA server listening on port ${PORT}`));
