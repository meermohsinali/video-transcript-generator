import { Router } from 'express';
import { randomUUID as uuid } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { jobs } from '../jobs-store.js';
import { upload } from '../middleware/upload.js';
import { processJob } from '../services/jobs-runner.js';
import { VARIANT_KEYS, variantLabel, generateVariant } from '../services/variants.js';

const router = Router();

function sanitizeQuery(req) {
  let { format } = req.query;
  format = String(format || 'txt').toLowerCase();
  if (!['txt', 'srt', 'vtt'].includes(format)) format = 'txt';
  return format;
}

function sanitizeLang(req) {
  let { lang } = req.query;
  lang = String(lang || 'original').toLowerCase();
  if (lang === 'original' || lang === 'src' || lang === 'source') return 'original';
  if (!VARIANT_KEYS.includes(lang)) return 'original';
  return lang;
}

function serializeJob(job) {
  return {
    id: job.id,
    provider: job.provider,
    language: job.language,
    model: job.model,
    vadFilter: job.vadFilter,
    status: job.status,
    message: job.message,
    progress: job.progress ?? 0,
    fileName: job.fileName,
    originalName: job.originalName,
    detectedLanguage: job.detectedLanguage,
    duration: job.duration,
    segments: job.segments || [],
    text: job.text || '',
    error: job.error || null,
    variants: Object.keys(job.variants || {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

router.post(
  '/jobs',
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Use multipart field "file".' });
      }

      const provider = String(req.body.provider || 'local').toLowerCase();
      const language = String(req.body.language || 'auto').toLowerCase();
      const model = String(req.body.model || '').toLowerCase()
        || (provider === 'local' ? config.localDefaultModel : config.geminiModels[0]);
      const apiKey = String(req.body.apiKey || '').trim();
      const cloudConsent = Boolean(req.body.cloudConsent);
      const vadFilter = Boolean(req.body.vadFilter !== undefined ? req.body.vadFilter : true);

      const validProvider = provider === 'local' || provider === 'gemini';
      const validLanguage = config.supportedLanguages.includes(language);
      const validModel = provider === 'local'
        ? config.localModels.includes(model)
        : config.geminiModels.includes(model);

      if (!validProvider) {
        return res.status(400).json({ error: 'provider must be "local" or "gemini"' });
      }
      if (!validLanguage) {
        return res.status(400).json({ error: 'language must be one of auto, hi, ur, en' });
      }
      if (!validModel) {
        return res.status(400).json({
          error: `model not supported for ${provider}. For local use: ${config.localModels.join(', ')}; for gemini use: ${config.geminiModels.join(', ')}`,
        });
      }
      if (provider === 'gemini' && !cloudConsent) {
        return res.status(400).json({ error: 'cloudConsent must be true for cloud provider.' });
      }
      if (provider === 'gemini' && apiKey.length < config.geminiMinKeyLength) {
        return res.status(400).json({ error: 'GEMINI_API_KEY is required.' });
      }

      const jobId = uuid();
      const filePath = req.file.path;
      const fileName = req.file.filename;
      const originalName = req.file.originalname || 'upload';

      const job = jobs.createJob({
        id: jobId,
        provider,
        language,
        model,
        vadFilter,
        apiKeyUsed: provider === 'gemini',
        fileName,
        originalName,
        filePath,
        status: 'queued',
        progress: 0,
        message: 'Job created and ready to run.',
      });

      res.status(202).json(serializeJob(job));

      setImmediate(() => {
        processJob(jobId, {
          provider,
          language,
          model,
          vadFilter,
          apiKey,
          cloudConsent,
          source: {
            filePath,
            fileName,
            originalName,
          },
        });
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(serializeJob(job));
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/cancel', async (req, res, next) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return res.status(409).json({ error: 'This job is already finished or cancelled.' });
    }
    jobs.updateJob(job.id, { status: 'cancelled', message: 'Cancellation requested by user.' });
    res.json(serializeJob(jobs.getJob(job.id)));
  } catch (err) {
    next(err);
  }
});

router.patch('/jobs/:id', async (req, res, next) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Editing is only allowed after transcription completes.' });
    }

    const newSegments = Array.isArray(req.body.segments)
      ? req.body.segments.map((s) => ({
          start: Number(s.start),
          end: Number(s.end),
          text: String(s.text || '').trim(),
        })).filter((s) => s.text.length > 0)
      : [];

    if (newSegments.length === 0) {
      return res.status(400).json({ error: 'At least one editable segment with text is required.' });
    }

    const updated = jobs.updateJob(job.id, {
      segments: newSegments,
      variants: {},
      message: 'Segment text was edited. Language versions were reset.',
    });
    res.json(serializeJob(updated));
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/variant', async (req, res, next) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Language versions are only available after transcription completes.' });
    }

    const lang = String(req.body.lang || 'original').toLowerCase();

    if (lang === 'original' || lang === 'src' || lang === 'source') {
      return res.json({
        lang: 'original',
        label: 'Original',
        segments: job.segments || [],
        text: job.text || '',
        cached: true,
        partial: false,
      });
    }

    if (!VARIANT_KEYS.includes(lang)) {
      return res.status(400).json({
        error: `lang must be one of original, ${VARIANT_KEYS.join(', ')}`,
      });
    }

    const cached = (job.variants || {})[lang];
    if (cached && Array.isArray(cached.segments) && cached.segments.length) {
      return res.json({ ...cached, cached: true });
    }

    const apiKey = String(req.body.apiKey || '').trim() || process.env.GEMINI_API_KEY || '';
    if (apiKey.length < config.geminiMinKeyLength) {
      return res.status(400).json({
        code: 'NEEDS_API_KEY',
        error: `Building the "${variantLabel(lang)}" version uses Google Gemini. Paste a Gemini API key in the field above and try again.`,
      });
    }

    const model = String(req.body.model || '');
    let result;
    try {
      result = await generateVariant({
        segments: job.segments || [],
        lang,
        apiKey,
        model,
        detectedLanguage: job.detectedLanguage,
        language: job.language,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ error: message });
    }

    jobs.setVariant(job.id, lang, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/export', async (req, res, next) => {
  try {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Export is only available for completed jobs.' });
    }

    const format = sanitizeQuery(req);
    const lang = sanitizeLang(req);

    let segments = job.segments || [];
    if (lang !== 'original') {
      const variant = (job.variants || {})[lang];
      if (!variant || !Array.isArray(variant.segments) || !variant.segments.length) {
        return res.status(409).json({
          error: `Generate the "${variantLabel(lang)}" version first by clicking its button, then download again.`,
        });
      }
      segments = variant.segments;
    }

    const baseName = (job.originalName || 'transcript').replace(/\.[^.]+$/, '');
    const suffix = lang === 'original' ? '' : `.${lang}`;
    const filename = `${baseName}${suffix}.${format}`;

    let body = '';
    if (format === 'txt') {
      body = segments.map((s) => s.text).filter(Boolean).join('\n\n');
    } else if (format === 'srt') {
      body = segments
        .map((s, i) => {
          const ss = String(Math.floor(s.start)).padStart(2, '0');
          const mm = String(Math.floor(s.start / 60)).padStart(2, '0');
          const hh = String(Math.floor(s.start / 3600)).padStart(2, '0');
          const se = String(Math.floor(s.end)).padStart(2, '0');
          const me = String(Math.floor(s.end / 60)).padStart(2, '0');
          const he = String(Math.floor(s.end / 3600)).padStart(2, '0');
          const ms = String(Math.floor((s.start % 1) * 1000)).padStart(3, '0');
          const me2 = String(Math.floor((s.end % 1) * 1000)).padStart(3, '0');
          return `${i + 1}\n${hh}:${mm}:${ss},${ms} --> ${he}:${me}:${se},${me2}\n${s.text}\n`;
        })
        .join('\n');
    } else {
      body = segments
        .map((s, i) => {
          const ss = String(Math.floor(s.start)).padStart(2, '0');
          const mm = String(Math.floor(s.start / 60)).padStart(2, '0');
          const hh = String(Math.floor(s.start / 3600)).padStart(2, '0');
          const se = String(Math.floor(s.end)).padStart(2, '0');
          const me = String(Math.floor(s.end / 60)).padStart(2, '0');
          const he = String(Math.floor(s.end / 3600)).padStart(2, '0');
          const ms = String(Math.floor((s.start % 1) * 1000)).padStart(3, '0');
          const me2 = String(Math.floor((s.end % 1) * 1000)).padStart(3, '0');
          return `${i + 1}\n${hh}:${mm}:${ss}.${ms} --> ${he}:${me}:${se}.${me2}\n${s.text}\n`;
        })
        .join('\n');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(body);
  } catch (err) {
    next(err);
  }
});

export { router as jobsRouter };