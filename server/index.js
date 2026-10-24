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
  const fullPrompt = `Create ONE clear, polished, high-resolution image based on this description: ${prompt}. Style: ${style || 'cinematic photorealism'}. COMPOSITION RULES: one main subject, simple readable composition, clear separation between foreground, middle ground and background, realistic proportions and perspective, clean object boundaries, balanced spacing, crisp focus, detailed textures, natural lighting and shadows. Avoid crowded scenes, duplicated objects, fused buildings, overlapping structures, tangled shapes, blurry details, visual noise, collage layouts, text, letters, watermarks and borders. Keep the requested subject recognizable and visually coherent. Output a finished image only, not SVG, code, or an explanation.`;
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
  // Translate Arabic into a faithful English image prompt; image models often follow English prompts more reliably.
  let imageDescription = String(prompt).trim();
  try {
    const translationModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const translationResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${translationModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Translate the user's image request into concise, precise English for an image-generation model. Preserve only the objects, scene, colors, lighting, and style explicitly requested. Do not invent people, characters, clothing, objects, or extra scenery. If no person is requested, explicitly say: no people. Return only the translated prompt. User request: ${prompt}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (translationResponse.ok) {
      const translationData = await translationResponse.json().catch(() => ({}));
      const translated = (translationData?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join(' ').trim();
      if (translated && translated.length > 5) imageDescription = translated;
    }
  } catch (translationError) {
    console.warn('Image prompt translation unavailable; using original prompt.');
  }

  // First fallback: legacy Pollinations endpoint (may require a key or return 402).
  try {
    const fallbackPrompt = `Faithfully create exactly the scene described here, without adding unrelated subjects: ${imageDescription}. Style: ${style || 'cinematic photorealism'}. Composition: one coherent scene, clear main subject, uncluttered background, realistic architecture and perspective, distinct buildings with visible gaps, sharp focus, clean edges, natural shadows, balanced cinematic lighting. Do not add people, faces, human figures, long-haired characters, clothing, or unrelated objects unless explicitly requested. No fused structures, duplicated objects, overlapping subjects, collage, blur, visual noise, text, watermark, border, icon, logo, infographic, or geometric placeholder.`;
    const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fallbackPrompt)}?width=1024&height=1024&model=flux&enhance=true&nologo=true`;
    const fallbackController = new AbortController();
    const fallbackTimeout = setTimeout(() => fallbackController.abort(), 45000);
    try {
      const fallbackResponse = await fetch(fallbackUrl, { signal: fallbackController.signal, headers: { Accept: 'image/*' } });
      const contentType = fallbackResponse.headers.get('content-type') || '';
      if (fallbackResponse.ok && contentType.startsWith('image/')) {
        const imageBuffer = Buffer.from(await fallbackResponse.arrayBuffer());
        if (imageBuffer.length > 1000) {
          return res.json({ title: String(prompt).trim().slice(0, 100) || 'الصورة الناتجة', image: `data:${contentType};base64,${imageBuffer.toString('base64')}`, mimeType: contentType, provider: 'fallback' });
        }
      }
      lastMessage = `Pollinations HTTP ${fallbackResponse.status}`;
      console.warn('Pollinations image fallback unavailable:', lastMessage);
    } finally {
      clearTimeout(fallbackTimeout);
    }
  } catch (fallbackError) {
    lastMessage = fallbackError?.message || 'Pollinations fallback failed';
    console.warn('Pollinations image fallback failed:', lastMessage);
  }

  // Second fallback: AI Horde anonymous community workers. This can be slower and queue-dependent.
  try {
    const hordePrompt = `${imageDescription}. ${style || 'cinematic photorealism'}, high detail, coherent uncluttered composition, realistic perspective, crisp focus, clean separation between objects, no unrelated subjects, no people unless explicitly requested, no text, no watermark.### blurry, low quality, overlapping objects, fused buildings, duplicate subjects, extra people, extra characters, long-haired person, text, watermark, logo, collage, geometric placeholders`;
    const hordeResponse = await fetch('https://aihorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'SANDA:1.0:public-web-app' },
      body: JSON.stringify({
        prompt: hordePrompt,
        params: { width: 512, height: 512, steps: 25, n: 1, cfg_scale: 7 },
        nsfw: false,
        censor_nsfw: true,
        r2: true,
        shared: true
      }),
      signal: AbortSignal.timeout(20000)
    });
    const hordeData = await hordeResponse.json().catch(() => ({}));
    if (!hordeResponse.ok || !hordeData?.id) {
      lastMessage = `AI Horde request failed (HTTP ${hordeResponse.status})`;
      console.warn('AI Horde image fallback unavailable:', lastMessage);
    } else {
      const jobId = hordeData.id;
      const deadline = Date.now() + 150000;
      let completed = false;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 4000));
        const checkResponse = await fetch(`https://aihorde.net/api/v2/generate/check/${encodeURIComponent(jobId)}`, {
          headers: { apikey: '0000000000', 'Client-Agent': 'SANDA:1.0:public-web-app' },
          signal: AbortSignal.timeout(12000)
        });
        const checkData = await checkResponse.json().catch(() => ({}));
        if (!checkResponse.ok) {
          lastMessage = `AI Horde status failed (HTTP ${checkResponse.status})`;
          break;
        }
        if (checkData?.faulted) {
          lastMessage = 'AI Horde worker could not generate the image.';
          break;
        }
        if (checkData?.done) { completed = true; break; }
      }
      if (completed) {
        const statusResponse = await fetch(`https://aihorde.net/api/v2/generate/status/${encodeURIComponent(jobId)}`, {
          headers: { apikey: '0000000000', 'Client-Agent': 'SANDA:1.0:public-web-app' },
          signal: AbortSignal.timeout(20000)
        });
        const statusData = await statusResponse.json().catch(() => ({}));
        const generated = statusData?.generations?.[0]?.img;
        if (statusResponse.ok && generated) {
          if (String(generated).startsWith('https://') || String(generated).startsWith('http://')) {
            const imageResponse = await fetch(generated, { signal: AbortSignal.timeout(20000) });
            const imageType = imageResponse.headers.get('content-type') || 'image/webp';
            if (imageResponse.ok && imageType.startsWith('image/')) {
              const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
              if (imageBuffer.length > 1000) {
                return res.json({ title: String(prompt).trim().slice(0, 100) || 'الصورة الناتجة', image: `data:${imageType};base64,${imageBuffer.toString('base64')}`, mimeType: imageType, provider: 'ai-horde' });
              }
            }
          } else {
            const imageBase64 = String(generated).replace(/^data:image\\/[^;]+;base64,/, '');
            if (imageBase64.length > 1000) {
              return res.json({ title: String(prompt).trim().slice(0, 100) || 'الصورة الناتجة', image: `data:image/webp;base64,${imageBase64}`, mimeType: 'image/webp', provider: 'ai-horde' });
            }
          }
        }
        lastMessage = 'AI Horde finished without returning a valid image.';
      } else if (!lastMessage) {
        lastMessage = 'AI Horde queue took longer than 150 seconds.';
      }
      console.warn('AI Horde image generation did not complete:', lastMessage);
    }
  } catch (hordeError) {
    lastMessage = hordeError?.message || 'AI Horde request failed';
    console.warn('AI Horde image fallback failed:', lastMessage);
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
