import { jobs } from '../jobs-store.js';
import { transcribeLocal } from '../providers/local.js';
import { transcribeGemini } from '../providers/gemini.js';

function mark(jobId, patch) {
  jobs.updateJob(jobId, patch);
}

export async function processJob(jobId, input) {
  const { provider, language, model, vadFilter, apiKey, source } = input;
  const { filePath, fileName, originalName } = source;

  if (!filePath) {
    jobs.updateJob(jobId, { status: 'failed', message: 'No uploaded file available.', error: 'Missing file path.' });
    return;
  }

  if (filePath.startsWith('\\') || filePath.startsWith('/')) {
    jobs.updateJob(jobId, { status: 'failed', message: 'Invalid file path.', error: 'Invalid uploaded file path.' });
    return;
  }

  if (provider === 'local') {
    try {
      await transcribeLocal(jobId, { audioPath: filePath, language, model, vadFilter });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobs.updateJob(jobId, { status: 'failed', message, error: message });
    }
    return;
  }

  if (provider === 'gemini') {
    try {
      await transcribeGemini(jobId, {
        audioPath: filePath,
        language,
        model,
        apiKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobs.updateJob(jobId, { status: 'failed', message, error: message });
    }
    return;
  }

  jobs.updateJob(jobId, { status: 'failed', message: 'Unsupported provider.', error: 'Unsupported provider.' });
}