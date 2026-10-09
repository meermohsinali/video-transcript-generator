import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { jobs } from '../src/jobs-store.js';

let server;
let base;
const created = [];

before(async () => {
  const app = await createApp();
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const id of created) {
    const job = jobs.getJob(id);
    if (job && job.fileName) {
      try {
        await fs.unlink(path.join(process.cwd(), 'uploads', job.fileName));
      } catch {
        // ignore missing upload
      }
    }
    jobs.deleteJob(id);
  }
  if (server) server.close();
});

function makeCompletedJob() {
  const id = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  created.push(id);
  jobs.createJob({
    id,
    provider: 'local',
    language: 'en',
    model: 'small',
    originalName: 'demo.mp4',
    filePath: 'demo.mp4',
    status: 'queued',
  });
  jobs.updateJob(id, {
    status: 'completed',
    progress: 100,
    detectedLanguage: 'en',
    segments: [
      { start: 0, end: 1.5, text: 'Hello everyone.' },
      { start: 1.5, end: 3, text: 'How are you?' },
    ],
    text: 'Hello everyone. How are you?',
  });
  return id;
}

test('health endpoint returns ok', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.ffmpeg, 'boolean');
});

test('unknown API routes return 404', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
});

test('POST /api/jobs requires a file', async () => {
  const res = await fetch(base + '/api/jobs', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /file/i);
});

test('completed job exposes its transcript and variant list', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}`);
  assert.equal(res.status, 200);
  const job = await res.json();
  assert.equal(job.status, 'completed');
  assert.equal(job.segments.length, 2);
  assert.deepEqual(job.variants, []);
});

test('variant endpoint asks for a Gemini key when none is configured', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}/variant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'ur' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NEEDS_API_KEY');
});

test('variant endpoint rejects unknown languages', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}/variant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'fr' }),
  });
  assert.equal(res.status, 400);
});

test('original variant returns the transcript immediately', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}/variant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'original' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lang, 'original');
  assert.equal(body.segments.length, 2);
});

test('export returns TXT for the original language', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}/export?format=txt`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Hello everyone/);
});

test('exporting an ungenerated language returns 409', async () => {
  const id = makeCompletedJob();
  const res = await fetch(base + `/api/jobs/${id}/export?format=srt&lang=ur`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Urdu/);
});

test('exporting a cached language uses its own segments', async () => {
  const id = makeCompletedJob();
  jobs.setVariant(id, 'ur', {
    lang: 'ur',
    label: 'Urdu',
    segments: [
      { start: 0, end: 1.5, text: 'ہیلو سب' },
      { start: 1.5, end: 3, text: 'کیسے ہو؟' },
    ],
    text: 'ہیلو سب کیسے ہو؟',
    partial: false,
    generatedAt: Date.now(),
  });
  const res = await fetch(base + `/api/jobs/${id}/export?format=txt&lang=ur`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /کیسے ہو/);
});

test('editing segments resets cached language versions', async () => {
  const id = makeCompletedJob();
  jobs.setVariant(id, 'hi', {
    lang: 'hi',
    label: 'Hindi',
    segments: [{ start: 0, end: 1.5, text: 'नमस्ते सब' }],
    text: 'नमस्ते सब',
    partial: false,
    generatedAt: Date.now(),
  });
  const res = await fetch(base + `/api/jobs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: [{ start: 0, end: 1.5, text: 'Edited line' }] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).variants, []);
});

test('POST /api/jobs accepts an upload and queues it', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake video bytes')], { type: 'video/mp4' }), 'clip.mp4');
  fd.append('provider', 'local');
  fd.append('language', 'en');
  fd.append('model', 'tiny');
  const res = await fetch(base + '/api/jobs', { method: 'POST', body: fd });
  assert.equal(res.status, 202);
  const job = await res.json();
  created.push(job.id);
  assert.equal(job.status, 'queued');
  await new Promise((r) => setTimeout(r, 1500));
  const polled = await (await fetch(base + `/api/jobs/${job.id}`)).json();
  assert.ok(
    ['queued', 'extracting', 'transcribing', 'completed', 'failed'].includes(polled.status),
    `unexpected status ${polled.status}`,
  );
});
