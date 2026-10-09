import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateVariant, VARIANT_KEYS, variantLabel } from '../src/services/variants.js';

function stubGemini(mapLine) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    const lines = JSON.parse(prompt.split('LINES TO CONVERT:\n')[1]);
    const payload = lines.map((line) => ({ i: line.i, t: mapLine(line.t, prompt) }));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
    };
  };
  return () => {
    global.fetch = original;
  };
}

const baseSegments = [
  { start: 0, end: 1.2, text: 'Hello everyone' },
  { start: 1.2, end: 2.4, text: 'How are you?' },
];

test('supported variants are English, Urdu, Roman Urdu, Hindi and Roman Hindi', () => {
  assert.deepEqual(VARIANT_KEYS, ['en', 'ur', 'ur_roman', 'hi', 'hi_roman']);
  assert.equal(variantLabel('ur_roman'), 'Roman Urdu');
  assert.equal(variantLabel('hi_roman'), 'Roman Hindi');
});

test('generateVariant keeps timings and rewrites every line', async () => {
  const restore = stubGemini((text) => `[converted] ${text}`);
  try {
    const result = await generateVariant({
      segments: baseSegments,
      lang: 'ur_roman',
      apiKey: 'fake-key-for-testing-0123456789',
      model: 'gemini-2.5-flash',
      detectedLanguage: 'en',
      language: 'en',
    });
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].start, 0);
    assert.equal(result.segments[1].end, 2.4);
    assert.equal(result.segments[0].text, '[converted] Hello everyone');
    assert.equal(result.partial, false);
    assert.match(result.text, /\[converted\]/);
  } finally {
    restore();
  }
});

test('generateVariant asks for Roman Urdu when lang is ur_roman', async () => {
  let seenPrompt = '';
  const restore = stubGemini((text, prompt) => {
    seenPrompt = prompt;
    return text;
  });
  try {
    await generateVariant({
      segments: baseSegments,
      lang: 'ur_roman',
      apiKey: 'fake-key-for-testing-0123456789',
      model: 'gemini-2.5-flash',
      detectedLanguage: 'en',
      language: 'en',
    });
    assert.match(seenPrompt, /Roman Urdu/);
    assert.match(seenPrompt, /SOURCE LANGUAGE: English/);
  } finally {
    restore();
  }
});

test('generateVariant flags partial output when a line comes back missing', async () => {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    const lines = JSON.parse(prompt.split('LINES TO CONVERT:\n')[1]);
    const payload = lines.slice(0, 1).map((line) => ({ i: line.i, t: 'केसे हो' }));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
    };
  };
  try {
    const result = await generateVariant({
      segments: baseSegments,
      lang: 'hi',
      apiKey: 'fake-key-for-testing-0123456789',
      model: 'gemini-2.5-flash',
      detectedLanguage: 'en',
      language: 'en',
    });
    assert.equal(result.partial, true);
    assert.equal(result.segments[0].text, 'केसे हो');
    assert.equal(result.segments[1].text, 'How are you?');
  } finally {
    global.fetch = original;
  }
});

test('generateVariant rejects unsupported variants and empty transcripts', async () => {
  await assert.rejects(
    () => generateVariant({ segments: baseSegments, lang: 'fr', apiKey: 'k'.repeat(30) }),
    /Unsupported language variant/,
  );
  await assert.rejects(
    () => generateVariant({ segments: [], lang: 'ur', apiKey: 'k'.repeat(30) }),
    /no transcript segments/,
  );
});
