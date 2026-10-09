import fs from 'node:fs/promises';
import { config } from '../config.js';
import { jobs } from '../jobs-store.js';

const BASE = 'https://generativelanguage.googleapis.com';
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB, same as Google's cookbook
const MAX_FILE_WAIT_MS = 5 * 60 * 1000;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

const LANGUAGE_HINTS = {
  en: 'English',
  hi: 'Hindi (write it in Devanagari script)',
  ur: 'Urdu (write it in Nastaliq Arabic script)',
  auto: 'mixed — keep each sentence in the language it was actually spoken',
};

function mark(jobId, patch) {
  jobs.updateJob(jobId, patch);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guessMime(filePath) {
  const dot = String(filePath).lastIndexOf('.');
  const ext = dot >= 0 ? String(filePath).slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function readErrorMessage(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data.error?.message || text || `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

function isModelMissingError(status, message) {
  return status === 404 || /not found|does not exist|is not found/i.test(message || '');
}

/**
 * Resumable upload exactly as Google's cookbook does it:
 * 1) start  -> obtain x-goog-upload-url
 * 2) upload -> 8 MiB chunks, last chunk carries ", finalize"
 */
async function uploadFile({ filePath, apiKey, displayName, jobId }) {
  const stat = await fs.stat(filePath);
  if (stat.size === 0) {
    throw new Error('The uploaded file is empty (0 bytes).');
  }
  const mime = guessMime(filePath);

  mark(jobId, { progress: 5, message: 'Starting upload to Google Gemini…' });

  const startRes = await fetch(`${BASE}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(stat.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) {
    throw new Error(`Gemini upload could not start (${startRes.status}): ${await readErrorMessage(startRes)}`);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini upload did not return an upload URL (x-goog-upload-url header missing).');
  }

  const handle = await fs.open(filePath, 'r');
  try {
    let offset = 0;
    while (offset < stat.size) {
      const wanted = Math.min(CHUNK_SIZE, stat.size - offset);
      const buf = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buf, 0, wanted, offset);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const isLast = offset + bytesRead >= stat.size;

      const chunkRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': String(offset),
          'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      });
      if (!chunkRes.ok) {
        throw new Error(`Gemini upload failed at byte ${offset} (${chunkRes.status}): ${await readErrorMessage(chunkRes)}`);
      }
      offset += bytesRead;
      mark(jobId, {
        progress: Math.min(30, 5 + Math.round((offset / stat.size) * 25)),
        message: `Uploading to Google Gemini… ${Math.round((offset / stat.size) * 100)}%`,
      });

      if (isLast) {
        const data = await chunkRes.json().catch(() => ({}));
        const file = data.file;
        if (!file || !file.name) {
          throw new Error('Gemini upload finished but the server returned no file reference.');
        }
        return file;
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  throw new Error('Gemini upload finished without a file reference.');
}

/** Poll the Files API until Google finished processing the upload. */
async function waitForFileActive(file, apiKey, jobId) {
  let current = file;
  const deadline = Date.now() + MAX_FILE_WAIT_MS;

  while (current.state !== 'ACTIVE') {
    if (current.state === 'FAILED') {
      const detail = current.error?.message || 'Google could not process this file.';
      throw new Error(`Gemini could not process the file: ${detail}`);
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for Google to finish processing the uploaded file (5 minutes).');
    }
    if (jobs.getJob(jobId)?.status === 'cancelled') {
      throw new Error('Cancelled.');
    }

    mark(jobId, { progress: 33, message: 'Google is processing the uploaded file…' });
    await sleep(1000);

    const res = await fetch(`${BASE}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      throw new Error(`Could not check the Gemini file status (${res.status}): ${await readErrorMessage(res)}`);
    }
    current = await res.json().catch(() => file);
  }
  return current;
}

function buildPrompt(language) {
  const hint = LANGUAGE_HINTS[language] || LANGUAGE_HINTS.auto;
  return `You are a professional multilingual subtitle transcription engine.

Transcribe the speech in this audio VERBATIM (word for word).

RULES:
- Language: ${hint}. Never translate. Never summarise. Never add commentary.
- If the speaker mixes English, Hindi and Urdu, keep every sentence in the language it was spoken: English in Latin script, Hindi in Devanagari script, Urdu in Nastaliq Arabic script.
- Split into short chronological cues: one sentence (or one natural clause) per entry, max about 12 words.
- "start" and "end" are seconds as JSON numbers, accurate to 0.1s, in strictly increasing order.
- Include every spoken sentence exactly once. Do not skip or repeat.
- Output ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{"language":"ur","segments":[{"start":0.0,"end":2.5,"text":"کیسے ہو؟"}]}
("language" = two-letter code of the dominant spoken language: en, hi or ur.)`;
}

function parseTranscript(raw) {
  const clean = String(raw || '')
    .trim()
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini returned invalid JSON instead of a transcript. ${message}`);
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!list || list.length === 0) {
    throw new Error('Gemini returned an empty transcript.');
  }

  const segments = [];
  let pendingStart = null;
  for (const item of list) {
    const text = String(item?.text ?? item?.t ?? '').trim();
    if (!text) continue;
    let start = Number(item?.start ?? item?.s);
    let end = Number(item?.end ?? item?.e);
    if (!Number.isFinite(start)) start = pendingStart ?? segments.length * 3;
    if (!Number.isFinite(end) || end < start) end = start + 3;
    pendingStart = end;
    segments.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, text });
  }
  if (segments.length === 0) {
    throw new Error('Gemini returned a transcript with no usable text.');
  }

  const detected = !Array.isArray(parsed) && typeof parsed.language === 'string'
    ? parsed.language.toLowerCase()
    : null;
  return { segments, detected };
}

/** Call generateContent, falling through the model list when a model is 404/retired. */
async function generateSegments({ file, apiKey, language, model, jobId }) {
  const candidates = [model, ...config.geminiModels.filter((m) => m !== model)];
  // Thinking MUST be off for a fast transcript: the Gemini docs call
  // transcription a "simple task" that should use minimal/low thinking. The bug
  // that made a 1-min clip take 287s was sending the WRONG knob per model —
  // Gemini 3.x uses thinkingLevel (a STRING "minimal"/"low") while Gemini 2.5
  // uses thinkingBudget (an INTEGER 0) — and some models SILENTLY IGNORE the
  // wrong field instead of erroring, so thinking stayed ON. Pick the correct
  // knob per model generation FIRST, then degrade gracefully if it's rejected.
  const MAX_ATTEMPTS = 3;
  const ROOMY_OUTPUT_TOKENS = 65536; // thinking + transcript share this budget

  function thinkingLadder(model) {
    const m = String(model || '').toLowerCase();
    const is3 = /gemini-3/.test(m);
    const cfg = (thinkingConfig) => ({
      temperature: 0.2,
      responseMimeType: 'application/json',
      maxOutputTokens: ROOMY_OUTPUT_TOKENS,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    });
    return [
      cfg(is3 ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 }), // correct knob first
      cfg(is3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0 }),
      cfg(is3 ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' }), // other generation's knob
      cfg(null), // no thinking knob
      { temperature: 0.2, responseMimeType: 'application/json' }, // no output cap (max compat)
    ];
  }

  let lastError = null;

  outer: for (const candidate of candidates) {
    for (const generationConfig of thinkingLadder(candidate)) {

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        const res = await fetch(
          `${BASE}/v1beta/models/${candidate}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: buildPrompt(language) },
                    { file_data: { file_uri: file.uri, mime_type: file.mimeType || guessMime(file.displayName || '') } },
                  ],
                },
              ],
              generationConfig,
            }),
          },
        );

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const parts = data.candidates?.[0]?.content?.parts || [];
          const raw = parts.map((p) => p.text || '').join('');
          if (!raw.trim()) {
            const block = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response';
            throw new Error(`Gemini returned an empty transcript (${block}).`);
          }
          return { ...parseTranscript(raw), modelUsed: candidate };
        }

        const message = await readErrorMessage(res);

        // Model retired / unknown -> try the next model immediately.
        if (isModelMissingError(res.status, message)) {
          lastError = new Error(`Model "${candidate}" is unavailable: ${message}`);
          continue outer;
        }
        // This model generation doesn't understand this thinking knob -> the
        // for..of ladder advances to the next generationConfig automatically.
        if (res.status === 400 && /thinking/i.test(message)) {
          break; // leave the retry loop, try the next ladder variant
        }
        // Auth problems never fix themselves -> stop with a clear message.
        if (res.status === 400 && /api key|API_KEY|permission|invalid/i.test(message)) {
          throw new Error(`Gemini rejected the API key: ${message}`);
        }
        // 503 "high demand" / 429 rate limit / 500 / 502 are temporary: retry
        // the same model a few times, then fall through to the next model.
        if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) {
          lastError = new Error(`Gemini transcription failed (${res.status}): ${message}`);
          if (attempt >= MAX_ATTEMPTS) {
            continue outer; // this model is overloaded -> try the next one
          }
          const backoffMs = 2000 * attempt; // 2s, 4s, 6s…
          mark(jobId, {
            message: `Gemini is busy (${res.status}) — retrying in ${Math.round(backoffMs / 1000)}s… (try ${attempt}/${MAX_ATTEMPTS})`,
          });
          await sleep(backoffMs);
          continue; // retry the same model + thinking variant
        }
        // Anything else is fatal for this model.
        throw new Error(`Gemini transcription failed (${res.status}): ${message}`);
      }
    }
  }

  throw lastError || new Error('No Gemini model responded. Check the selected model list.');
}

async function deleteFileQuietly(file, apiKey) {
  if (!file || !file.name) return;
  try {
    await fetch(`${BASE}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`, { method: 'DELETE' });
  } catch {
    // Google expires uploaded files automatically; best effort only.
  }
}

export async function transcribeGemini(jobId, input) {
  const { audioPath, language, model, apiKey } = input;

  if (!apiKey || apiKey.length < config.geminiMinKeyLength) {
    throw new Error('A Gemini API key is required for the Google provider.');
  }

  let uploaded = null;
  let heartbeat = null;
  const startedAt = Date.now();
  try {
    mark(jobId, { status: 'transcribing', progress: 3, message: 'Contacting Google Gemini…' });

    uploaded = await uploadFile({
      filePath: audioPath,
      apiKey,
      displayName: `job-${jobId}`,
      jobId,
    });
    const afterUpload = Date.now();
    uploaded = await waitForFileActive(uploaded, apiKey, jobId);
    const afterProcessing = Date.now();

    mark(jobId, { progress: 40, message: 'Transcribing with Google Gemini…' });

    // Keep the UI alive during the one long blocking call: a visible heartbeat
    // with elapsed seconds so "loading" never looks frozen.
    heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const job = jobs.getJob(jobId);
      if (!job || job.status === 'cancelled') return;
      if (job.progress < 40) return;
      mark(jobId, { message: `Transcribing with Google Gemini… ${secs}s elapsed` });
    }, 5000);

    const { segments, detected, modelUsed } = await generateSegments({
      file: uploaded,
      apiKey,
      language,
      model: model || config.geminiModels[0],
      jobId,
    });
    const afterGenerate = Date.now();

    const text = segments.map((s) => s.text).join(' ');
    const detectedLanguage = ['en', 'hi', 'ur'].includes(detected)
      ? detected
      : (language && language !== 'auto' ? language : detected || 'auto');

    if (jobs.getJob(jobId)?.status === 'cancelled') {
      return;
    }

    const uploadS = Math.round((afterUpload - startedAt) / 1000);
    const processS = Math.round((afterProcessing - afterUpload) / 1000);
    const aiS = Math.round((afterGenerate - afterProcessing) / 1000);

    mark(jobId, {
      status: 'completed',
      progress: 100,
      segments,
      text,
      duration: segments.length ? segments[segments.length - 1].end : null,
      detectedLanguage,
      message: `Transcription complete (Gemini ${modelUsed}) — upload ${uploadS}s · Google processing ${processS}s · AI ${aiS}s.`,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (uploaded) {
      await deleteFileQuietly(uploaded, apiKey);
    }
  }
}

