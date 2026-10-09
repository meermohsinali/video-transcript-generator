import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  rootDir: path.resolve(__dirname, '..', '..'),
  srcDir: __dirname,
  publicDir: path.resolve(__dirname, '..', 'public'),
  uploadsDir: path.resolve(process.cwd(), 'uploads'),
  dataDir: path.resolve(process.cwd(), 'data'),
  tmpDir: path.resolve(process.cwd(), 'tmp'),
  port: Number(process.env.PORT || 3000),
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  supportedLanguages: ['auto', 'hi', 'ur', 'en'],
  // Default for non-Urdu/Hindi. For ur/hi we switch to 'large-v3-turbo'
  // automatically in the worker because small/base simply cannot transcribe
  // Urdu accurately (they produce garbled Nastaliq like "نواتی/ترچ").
  localDefaultModel: 'base',
  localModels: ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'],
  // The only local model with acceptable Urdu/Hindi accuracy. Slow on a weak
  // CPU but correct; small/base are fast but wrong for these languages.
  localAccurateModel: 'large-v3-turbo',
  // Current stable Google models first; older ones stay in the list only as
  // fallbacks so a retired model ID can never 404 the whole job.
  geminiModels: ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'],
  geminiMinKeyLength: 20,
  maxJobDurationSeconds: 3600 * 12,
  localPython: process.env.GEMINI_LOCAL_PYTHON || 'python',
};