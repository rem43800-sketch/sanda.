import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const videoJobs = new Map();
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


const videoDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runVideoJob(jobId) {
  const job = videoJobs.get(jobId);
  if (!job) return;
  const deadline = Date.now() + 14 * 60 * 1000;
  let externalVideoId = '';
  let attempt = 0;

  const fail = message => {
    job.status = 'failed';
    job.error = message;
    job.message = message;
    job.updatedAt = Date.now();
  };

  // Submit with a gentle backoff. Queue-full responses are retried in the background
  // so the browser request itself does not time out while the provider is busy.
  while (Date.now() < deadline && !externalVideoId) {
    attempt += 1;
    job.status = 'queued';
    job.message = 'طابور المزوّد مزدحم؛ سَندَ سيعيد المحاولة تلقائيًا.';
    job.updatedAt = Date.now();
    let response;
    let data = {};
    try {
      response = await fetch('https://apihub.agnes-ai.com/v1/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AGNES_API_KEY },
        body: JSON.stringify({
          model: 'agnes-video-2.5-flash',
          prompt: job.prompt,
          mode: 'text',
          seconds: '5',
          size: '720P',
          aspect_ratio: '16:9',
          n: 1
        }),
        signal: AbortSignal.timeout(30000)
      });
      data = await response.json().catch(() => ({}));
    } catch (err) {
      console.warn('Agnes video submission transport issue:', err?.message || 'unknown', 'attempt', attempt);
      await videoDelay(Math.min(attempt * 30000, 90000));
      continue;
    }

    if (response.ok) {
      externalVideoId = String(data.video_id || data.id || data.task_id || '');
      if (!externalVideoId) {
        fail('مزوّد الفيديو لم يُرجع رقم المهمة.');
        return;
      }
      job.providerVideoId = externalVideoId;
      job.status = 'processing';
      job.message = 'قبل المزوّد الطلب؛ جارٍ إنشاء الفيديو.';
      job.updatedAt = Date.now();
      break;
    }

    const providerMessage = String(data?.error?.message || data?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 240);
    const isQueueFull = /queue is full|video_queue_full|queue.{0,25}full/i.test(providerMessage);
    console.warn('Agnes video submission failed:', response.status, providerMessage || 'no provider message', 'attempt', attempt);

    if (response.status === 401 || response.status === 403) {
      fail('مفتاح محرك الفيديو غير مقبول أو لا يملك صلاحية الوصول.');
      return;
    }
    if (!isQueueFull && ![408, 429, 500, 502, 503, 504, 520, 522, 524].includes(response.status)) {
      fail('تعذّر إرسال الفيديو إلى المزوّد (HTTP ' + response.status + '). ' + (providerMessage || 'حاولي لاحقًا.'));
      return;
    }
    job.status = 'queued';
    job.message = isQueueFull
      ? 'الطابور المجاني ممتلئ حاليًا؛ سَندَ يحاول تلقائيًا كل فترة.'
      : 'المزوّد مشغول مؤقتًا؛ سَندَ سيعيد المحاولة تلقائيًا.';
    job.updatedAt = Date.now();
    await videoDelay(Math.min(attempt * 30000, 90000));
  }

  if (!externalVideoId) {
    fail('ظلّ طابور الفيديو مزدحمًا بعد انتظار وإعادة المحاولة تلقائيًا. لم تُنشأ مهمة فيديو؛ جرّبي لاحقًا.');
    return;
  }

  // Poll the accepted task in the background, leaving the client free to poll our job status.
  while (Date.now() < deadline) {
    try {
      const resultResponse = await fetch(
        'https://apihub.agnes-ai.com/agnesapi?video_id=' + encodeURIComponent(externalVideoId) + '&model_name=agnes-video-2.5-flash',
        { headers: { Authorization: 'Bearer ' + process.env.AGNES_API_KEY }, signal: AbortSignal.timeout(20000) }
      );
      const result = await resultResponse.json().catch(() => ({}));
      if (resultResponse.status === 401 || resultResponse.status === 403) {
        fail('مفتاح محرك الفيديو غير مقبول عند التحقق من النتيجة.');
        return;
      }
      const status = String(result.status || 'pending').toLowerCase();
      if (['failed', 'error', 'faulted'].includes(status)) {
        fail(String(result.error || result.message || 'لم يكتمل إنشاء الفيديو لدى المزوّد.'));
        return;
      }
      const videoUrl = result.video_url || result.url || result.output?.video_url || result.metadata?.url;
      if (resultResponse.ok && ['completed', 'complete', 'succeeded', 'success'].includes(status) && typeof videoUrl === 'string' && videoUrl.startsWith('https://')) {
        job.status = 'completed';
        job.videoUrl = videoUrl;
        job.progress = 100;
        job.message = 'اكتمل الفيديو.';
        job.updatedAt = Date.now();
        return;
      }
      job.status = 'processing';
      job.progress = Math.max(0, Math.min(99, Number(result.progress) || 0));
      job.message = 'قبل المزوّد المهمة؛ جارٍ إنشاء الفيديو.';
      job.updatedAt = Date.now();
    } catch (err) {
      console.warn('Agnes video status check failed:', err?.message || 'unknown');
    }
    await videoDelay(20000);
  }

  fail('ما زال الفيديو قيد المعالجة بعد 14 دقيقة. لم يبدأ سَندَ طلبًا آخر؛ جرّبي التحقق لاحقًا.');
}

app.post('/api/video', async (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'اكتبي وصف الفيديو أولًا.' });
  if (!process.env.AGNES_API_KEY) return res.status(503).json({ error: 'مفتاح محرك الفيديو غير مضاف إلى الخادم.' });

  // Keep this simple in-memory queue bounded on the free Render instance.
  const now = Date.now();
  for (const [id, oldJob] of videoJobs) {
    if (['completed', 'failed'].includes(oldJob.status) && now - oldJob.updatedAt > 30 * 60 * 1000) videoJobs.delete(id);
  }
  const activeJobs = [...videoJobs.values()].filter(job => ['queued', 'processing'].includes(job.status)).length;
  if (activeJobs >= 2) {
    return res.status(429).json({ error: 'يوجد طلب فيديو قيد الانتظار بالفعل. انتظري نتيجته قبل إرسال طلب آخر.' });
  }

  const videoId = randomUUID();
  videoJobs.set(videoId, {
    id: videoId,
    prompt: prompt.trim().slice(0, 3000),
    status: 'queued',
    message: 'أُضيف الطلب إلى قائمة الانتظار؛ سَندَ سيعيد المحاولة تلقائيًا.',
    progress: 0,
    createdAt: now,
    updatedAt: now
  });
  res.json({ videoId, modelName: 'agnes-video-2.5-flash', status: 'pending' });
  void runVideoJob(videoId).catch(err => {
    console.error('Unexpected video job failure:', err?.message || 'unknown');
    const job = videoJobs.get(videoId);
    if (job) {
      job.status = 'failed';
      job.error = 'حدث خطأ غير متوقع أثناء معالجة الفيديو.';
      job.message = job.error;
      job.updatedAt = Date.now();
    }
  });
});

app.get('/api/video/:videoId', async (req, res) => {
  const id = String(req.params.videoId || '');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return res.status(400).json({ error: 'رقم مهمة الفيديو غير صالح.' });

  const localJob = videoJobs.get(id);
  if (localJob) {
    if (localJob.status === 'failed') return res.json({ status: 'failed', error: localJob.error || localJob.message });
    if (localJob.status === 'completed') return res.json({ status: 'completed', videoUrl: localJob.videoUrl, progress: 100 });
    return res.json({ status: 'processing', progress: localJob.progress || 0, message: localJob.message || 'جارٍ إنشاء الفيديو.' });
  }

  if (!process.env.AGNES_API_KEY) return res.status(503).json({ error: 'مفتاح محرك الفيديو غير مضاف إلى الخادم.' });
  try {
    const modelName = 'agnes-video-2.5-flash';
    const r = await fetch('https://apihub.agnes-ai.com/agnesapi?video_id=' + encodeURIComponent(id) + '&model_name=' + encodeURIComponent(modelName), { headers: { Authorization: 'Bearer ' + process.env.AGNES_API_KEY }, signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'تعذّر التحقق من حالة الفيديو.' });
    const status = String(d.status || 'pending').toLowerCase();
    if (status === 'failed' || status === 'error') return res.json({ status: 'failed', error: d.error || 'لم يكتمل إنشاء الفيديو.' });
    const videoUrl = d.video_url || d.url || d.output?.video_url || d.metadata?.url;
    if (['completed', 'complete', 'succeeded', 'success'].includes(status) && typeof videoUrl === 'string' && videoUrl.startsWith('https://')) return res.json({ status: 'completed', videoUrl });
    return res.json({ status: 'processing', progress: Number(d.progress) || 0 });
  } catch { return res.status(502).json({ error: 'انقطع الاتصال أثناء متابعة الفيديو.' }); }
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
    console.warn('Image prompt translation unavailable; trying public translation fallback.');
  }

  // If Gemini translation is quota-blocked, translate Arabic to English before sending it to image providers.
  if (/[\u0600-\u06FF]/.test(imageDescription)) {
    try {
      const translateUrl = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=en&dt=t&q=' + encodeURIComponent(imageDescription);
      const translateResponse = await fetch(translateUrl, { signal: AbortSignal.timeout(10000) });
      if (translateResponse.ok) {
        const translateData = await translateResponse.json();
        const translatedText = Array.isArray(translateData?.[0]) ? translateData[0].map(segment => Array.isArray(segment) ? segment[0] || '' : '').join('').trim() : '';
        if (translatedText.length > 5 && !/[\u0600-\u06FF]/.test(translatedText)) {
          imageDescription = translatedText;
          console.log('Arabic image prompt translated to English using fallback translator.');
        }
      }
    } catch {
      console.warn('Fallback image prompt translation failed.');
    }
  }

  // Skip Pollinations because it has returned unrelated images.
  console.log('Gemini image quota unavailable; switching directly to AI Horde fallback.');

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
      console.log('AI Horde accepted image job; waiting for a community worker.');
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
        if (checkData?.done) { completed = true; console.log('AI Horde image job completed.'); break; }
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
            const imageBase64 = String(generated).includes(',') ? String(generated).slice(String(generated).indexOf(',') + 1) : String(generated);
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
