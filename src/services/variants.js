import { config } from '../config.js';

export const VARIANT_KEYS = ['en', 'ur', 'ur_roman', 'hi', 'hi_roman'];

export const VARIANT_LABELS = {
  en: 'English',
  ur: 'Urdu',
  ur_roman: 'Roman Urdu',
  hi: 'Hindi',
  hi_roman: 'Roman Hindi',
};

const TARGETS = {
  en: {
    name: 'English (Latin script, standard English wording)',
    rule: 'Translate each line into natural, standard English.',
    example: 'kese ho -> how are you',
  },
  ur: {
    name: 'Urdu written in Nastaliq / Arabic script (اردو)',
    rule: 'Translate each line into Urdu using the Arabic-based Urdu script.',
    example: 'kese ho -> کیسے ہو',
  },
  ur_roman: {
    name: 'Roman Urdu (Urdu words written with the Latin alphabet)',
    rule: 'Rewrite each line in Roman Urdu: Urdu vocabulary and grammar, but typed with English letters. Never use Arabic script.',
    example: 'کیسے ہو -> kese ho ; کیا حال ہے -> kya haal hai',
  },
  hi: {
    name: 'Hindi written in Devanagari script (हिन्दी)',
    rule: 'Translate each line into Hindi using the Devanagari script.',
    example: 'kese ho -> केसे हो',
  },
  hi_roman: {
    name: 'Roman Hindi / Hinglish (Hindi words written with the Latin alphabet)',
    rule: 'Rewrite each line in Roman Hindi: Hindi vocabulary and grammar, but typed with English letters. Never use Devanagari.',
    example: 'केसे हो -> kaise ho ; क्या हाल है -> kya haal hai',
  },
};

const SOURCE_LABELS = {
  en: 'English',
  hi: 'Hindi',
  ur: 'Urdu',
  auto: 'unknown (detect it yourself from the text)',
};

export function isVariantKey(key) {
  return VARIANT_KEYS.includes(String(key || '').toLowerCase());
}

export function variantLabel(key) {
  return VARIANT_LABELS[key] || key;
}

function sourceLabel(detectedLanguage, fallbackLanguage) {
  const code = String(detectedLanguage || fallbackLanguage || 'auto').toLowerCase();
  return SOURCE_LABELS[code] || `language code "${code}"`;
}

function chunkSegments(segments, maxItems = 40, maxChars = 6000) {
  const chunks = [];
  let current = [];
  let chars = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const text = String(segments[i].text || '');
    if (current.length >= maxItems || (current.length > 0 && chars + text.length > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push({ i, t: text });
    chars += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function buildPrompt({ target, source, lines }) {
  return `You are a professional subtitle localisation engine.

SOURCE LANGUAGE: ${source}
TARGET: ${target.name}

RULES:
- ${target.rule}
- Example of the required style: ${target.example}
- Process each line independently. Keep the same meaning, tone, register and level of formality.
- Keep numbers, brand names, URLs and untranslatable names as they are.
- Keep every line short enough to fit as one subtitle cue. Do not merge or split lines.
- Do not skip, reorder or add lines. Every index must appear exactly once.
- Preserve proper punctuation for the target script.
- Output ONLY a JSON array with no markdown fences and no commentary, in exactly this shape:
[{"i":0,"t":"text for line 0"},{"i":1,"t":"text for line 1"}]

LINES TO CONVERT:
${JSON.stringify(lines)}
`;
}

function thinkingLadder(model) {
  const m = String(model || '').toLowerCase();
  const is3 = /gemini-3/.test(m);
  const cfg = (thinkingConfig) => ({
    temperature: 0.2,
    responseMimeType: 'application/json',
    maxOutputTokens: 65536,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  });
  return [
    cfg(is3 ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 }),
    cfg(is3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0 }),
    cfg(is3 ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' }),
    cfg(null),
    { temperature: 0.2, responseMimeType: 'application/json' },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function callGemini({ apiKey, model, prompt, onProgress }) {
  const BASE = 'https://generativelanguage.googleapis.com';
  const candidates = [model, ...config.geminiModels.filter((m) => m !== model)];
  const MAX_ATTEMPTS = 3;
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
            // A hung Google call would otherwise leave the UI's language buttons
            // disabled forever waiting for this response.
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig,
            }),
          },
        );

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const parts = data.candidates?.[0]?.content?.parts || [];
          const raw = parts.map((p) => p.text || '').join('').trim();
          if (!raw) {
            throw new Error('Gemini returned an empty response while building the language variant.');
          }
          const clean = raw.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          let parsed;
          try {
            parsed = JSON.parse(clean);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Gemini returned invalid JSON for the language variant. ${message}`);
          }
          if (!Array.isArray(parsed)) {
            throw new Error('Gemini returned an unexpected shape for the language variant.');
          }
          return parsed;
        }

        const message = await readErrorMessage(res);

        // Model retired / unknown -> try the next known model immediately.
        if (isModelMissingError(res.status, message)) {
          lastError = new Error(`Model "${candidate}" is unavailable: ${message}`);
          continue outer;
        }
        // This model generation doesn't understand this thinking knob -> advance
        // to the next ladder variant.
        if (res.status === 400 && /thinking/i.test(message)) {
          break;
        }
        // Auth problems never fix themselves -> stop with a clear message.
        if (res.status === 400 && /api key|API_KEY|permission|invalid/i.test(message)) {
          throw new Error(`Gemini rejected the API key: ${message}`);
        }
        // 503 "high demand" / 429 / 500 / 502 are temporary: retry the same
        // model a few times, then fall through to the next model.
        if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) {
          lastError = new Error(`Gemini request failed (${res.status}): ${message}`);
          if (attempt >= MAX_ATTEMPTS) {
            continue outer;
          }
          const backoffMs = 2000 * attempt;
          if (typeof onProgress === 'function') {
            onProgress(`Gemini is busy (${res.status}), retrying in ${Math.round(backoffMs / 1000)}s... (try ${attempt}/${MAX_ATTEMPTS})`);
          }
          await sleep(backoffMs);
          continue;
        }
        // Anything else is fatal for this model.
        throw new Error(`Gemini request failed (${res.status}): ${message}`);
      }
    }
  }

  throw lastError || new Error('No Gemini model responded while building the language variant.');
}

/**
 * Builds one language variant (English, Urdu, Roman Urdu, Hindi, Roman Hindi)
 * from the already-transcribed segments. Segment timings are preserved exactly;
 * only the text is replaced.
 */
export async function generateVariant({ segments, lang, apiKey, model, detectedLanguage, language }) {
  const target = TARGETS[lang];
  if (!target) {
    throw new Error(`Unsupported language variant "${lang}".`);
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('This job has no transcript segments to convert yet.');
  }

  const resolvedModel = config.geminiModels.includes(model) ? model : config.geminiModels[0];
  const source = sourceLabel(detectedLanguage, language);
  const chunks = chunkSegments(segments);

  const out = segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  let partial = false;

  for (const lines of chunks) {
    const items = await callGemini({
      apiKey,
      model: resolvedModel,
      prompt: buildPrompt({ target, source, lines }),
    });

    const byIndex = new Map();
    for (const item of items) {
      const idx = Number(item?.i ?? item?.index);
      const value = item?.t ?? item?.text;
      if (Number.isFinite(idx) && typeof value === 'string' && value.trim().length) {
        byIndex.set(idx, value.trim());
      }
    }

    if (byIndex.size === 0) {
      throw new Error(`Gemini produced no usable lines for the "${variantLabel(lang)}" version.`);
    }

    for (const line of lines) {
      const converted = byIndex.get(line.i);
      if (converted) {
        out[line.i] = { ...out[line.i], text: converted };
      } else {
        partial = true;
      }
    }
  }

  const kept = out.map((s) => ({ ...s, text: String(s.text || '').trim() })).filter((s) => s.text.length > 0);

  return {
    lang,
    label: variantLabel(lang),
    segments: kept,
    text: kept.map((s) => s.text).join(' '),
    partial,
    generatedAt: Date.now(),
  };
}

