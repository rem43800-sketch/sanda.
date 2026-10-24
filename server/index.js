import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY) }));
app.post('/api/ai', async (req, res) => {
  const { prompt, schema } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'اكتب وصفًا واضحًا أولًا.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'خدمة الذكاء الاصطناعي غير مفعّلة بعد. أضف ANTHROPIC_API_KEY إلى ملف .env في الخادم. لا تضع المفتاح في المتصفح.' });
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
      max_tokens: 4096,
      system: `أنت مساعد منصة سَندَ العربية. أجب بالعربية ما لم يطلب المستخدم غير ذلك. أعد JSON صالحًا فقط، بلا Markdown. البنية المطلوبة: ${schema || 'JSON مناسب للمهمة'}`,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = response.content.filter(x => x.type === 'text').map(x => x.text).join('\n').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let result;
    try { result = JSON.parse(raw); } catch { return res.status(502).json({ error: 'وصل رد من النموذج لكن تعذّر قراءته كـ JSON. جرّب وصفًا أقصر.' }); }
    return res.json({ result });
  } catch (err) {
    console.error('AI request failed:', err?.status || err?.message || 'unknown');
    const status = err?.status === 401 ? 401 : 502;
    return res.status(status).json({ error: status === 401 ? 'مفتاح API غير صحيح. راجع إعدادات الخادم.' : 'تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من المفتاح والرصيد والاتصال ثم أعد المحاولة.' });
  }
});

// Serve the built frontend in production. During development Vite serves the client.
const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), err => { if (err) next(); });
});
app.listen(PORT, () => console.log(`SANDA server listening on http://localhost:${PORT}`));
