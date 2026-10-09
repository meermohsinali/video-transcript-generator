import fs from 'node:fs/promises';
import { config } from './config.js';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureDirs() {
  await ensureDir(config.uploadsDir);
  await ensureDir(config.dataDir);
  await ensureDir(config.tmpDir);
}
