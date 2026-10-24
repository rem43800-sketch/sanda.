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
    const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const modelsToTry = [...new Set([primaryModel, 'gemini-3.5-flash-lite', 'gemini-3.6-flash'])];
    const requestBody = JSON.stringify({
      systemInstruction: {
        parts: [{ text: `أنت مساعد منصة سَندَ العربية. أجب باللغة التي يطلبها المستخدم، والعربية افتراضيًا. أعد JSON صالحًا فقط دون Markdown. البنية المطلوبة: ${schema || 'JSON مناسب للمهمة'}` }]
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 4096 }
    });

    // Try stable fallback models when the primary model is temporarily overloaded.
    let response;
    let data = {};
    let lastStatus = 0;
    for (const model of modelsToTry) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal
        });
        data = await response.json().catch(() => ({}));
      } catch (err) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') {
          console.warn(`Gemini request timed out for model ${model}`);
          continue;
        }
        console.warn(`Gemini request failed for model ${model}:`, err?.message || 'unknown');
        continue;
      } finally {
        clearTimeout(timeoutId);
      }
      if (response.ok) break;
      lastStatus = response.status;
      console.warn(`Gemini model ${model} returned HTTP ${response.status}:`, data?.error?.message || 'unknown');
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    }
    if (!response?.ok) {
      return res.status(502).json({
        error: lastStatus === 429 || lastStatus === 503
          ? 'خدمة الذكاء الاصطناعي مزدحمة مؤقتًا. انتقلنا بين النماذج المتاحة؛ يرجى المحاولة بعد قليل.'
          : 'نواجه مشكلة مؤقتة في إنشاء النتيجة. يرجى المحاولة لاحقًا.'
      });
    }

    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('\n').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    try {
      return res.json({ result: JSON.parse(raw) });
    } catch {
      // Some model responses wrap valid JSON in extra text; recover the JSON object if possible.
      const first = raw.indexOf('{');
      const last = raw.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          return res.json({ result: JSON.parse(raw.slice(first, last + 1)) });
        } catch {}
      }
      console.error('Gemini returned invalid JSON:', raw.slice(0, 500));
      return res.status(502).json({ error: 'وصلت استجابة غير مكتملة من الذكاء الاصطناعي. جرّب وصفًا أقصر.' });
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.warn('Gemini request timed out after 90 seconds');
      return res.status(504).json({ error: 'تأخر مزوّد الذكاء الاصطناعي في الرد. جرّب مرة أخرى بعد دقيقة؛ لم تُحذف فكرتك.' });
    }
    console.error('Gemini request failed:', err?.message || 'unknown');
    return res.status(502).json({ error: 'نواجه مشكلة مؤقتة في إنشاء النتيجة. يرجى المحاولة لاحقًا.' });
  }
});


app.post('/api/image', async (req, res) => {
  const { prompt, style } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'اكتب وصف الصورة أولًا.' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'خدمة إنشاء الصور غير مهيأة على الخادم.' });
  }
  const fullPrompt = `Generate one high-quality image from this description: ${prompt}. Visual direction: ${style || 'cinematic photorealistic concept art'}. Create a polished, detailed, professional image with rich lighting, depth, realistic materials, coherent perspective, nuanced textures, and strong composition. Do not create an icon, logo, infographic, wireframe, geometric placeholder, or simple shapes unless explicitly requested. No text, letters, watermark, or border. Return the actual image, not SVG or code.`;
  const modelsToTry = [...new Set([
    process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    'gemini-3.1-flash-image-preview'
  ])];
  let lastMessage = '';
  for (const model of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastMessage = data?.error?.message || `HTTP ${response.status}`;
        console.warn(`Gemini image model ${model} returned HTTP ${response.status}:`, lastMessage);
        if ([400, 401, 403, 404, 429, 500, 502, 503, 504].includes(response.status)) continue;
        break;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(part => part?.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('image/'));
      if (imagePart) {
        return res.json({
          title: String(prompt).trim().slice(0, 100) || 'الصورة الناتجة',
          image: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
          mimeType: imagePart.inlineData.mimeType
        });
      }
      lastMessage = parts.map(part => part.text || '').join(' ').slice(0, 300) || 'لم يُرجع النموذج بيانات صورة.';
      console.warn(`Gemini image model ${model} returned no image:`, lastMessage);
    } catch (err) {
      lastMessage = err?.name === 'AbortError' ? 'انتهت مهلة إنشاء الصورة.' : (err?.message || 'unknown');
      console.warn(`Gemini image request failed for model ${model}:`, lastMessage);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return res.status(502).json({ error: 'تعذّر إنشاء صورة فعلية من مزوّد الصور حاليًا. ' + (lastMessage ? 'التفاصيل: ' + lastMessage : 'حاول لاحقًا.') });
});

const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), err => { if (err) next(); });
});
app.listen(PORT, () => console.log(`SANDA server listening on port ${PORT}`));
