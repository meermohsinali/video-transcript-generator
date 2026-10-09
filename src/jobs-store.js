import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { ensureDir } from './paths.js';

const store = new Map();
let loaded = false;
let saving = null;
let saveTimer = null;

function jobsFilePath() {
  return path.join(config.dataDir, 'jobs.json');
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

async function load() {
  if (loaded) return;
  try {
    await ensureDir(config.dataDir);
    const raw = await fs.readFile(jobsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const job of parsed) {
        if (job && job.id) store.set(job.id, job);
      }
    }
  } catch {
    // First run, or corrupt file: start with an empty store.
  }
  loaded = true;
}

async function persist() {
  if (!loaded) return;
  await ensureDir(config.dataDir);
  const file = jobsFilePath();
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify([...store.values()], null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, file);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const run = saving ? saving.then(() => persist()) : persist();
    saving = run.catch(() => {});
  }, 200);
}

export const jobs = {
  async init() {
    await load();
  },

  createJob(input) {
    const now = Date.now();
    const job = {
      id: input.id,
      provider: input.provider || 'local',
      language: input.language || 'auto',
      model: input.model || '',
      vadFilter: input.vadFilter !== false,
      apiKeyUsed: Boolean(input.apiKeyUsed),
      fileName: input.fileName || '',
      originalName: input.originalName || 'upload',
      filePath: input.filePath || '',
      status: input.status || 'queued',
      progress: typeof input.progress === 'number' ? input.progress : 0,
      message: input.message || 'Job created.',
      detectedLanguage: input.detectedLanguage || null,
      duration: input.duration ?? null,
      segments: [],
      text: '',
      error: null,
      variants: {},
      createdAt: now,
      updatedAt: now,
    };
    store.set(job.id, job);
    scheduleSave();
    return clone(job);
  },

  getJob(id) {
    const job = store.get(id);
    return job ? clone(job) : null;
  },

  updateJob(id, patch) {
    const job = store.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    scheduleSave();
    return clone(job);
  },

  setVariant(id, lang, data) {
    const job = store.get(id);
    if (!job) return null;
    if (!job.variants) job.variants = {};
    job.variants[lang] = data;
    job.updatedAt = Date.now();
    scheduleSave();
    return clone(job);
  },

  listJobs() {
    return [...store.values()].map(clone);
  },

  deleteJob(id) {
    const existed = store.delete(id);
    if (existed) scheduleSave();
    return existed;
  },
};
