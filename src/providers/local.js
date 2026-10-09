import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { jobs } from '../jobs-store.js';

const workerPath = path.resolve(config.srcDir, 'workers', 'local_worker.py');

function mark(jobId, patch) {
  jobs.updateJob(jobId, patch);
}

async function checkFfmpeg() {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    await new Promise((resolve) => {
      const proc = spawn(command, ['-version'], { windowsHide: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch {}
        resolve(false);
      }, 4000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && !timedOut);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    return { available: true };
  } catch {
    return { available: false, message: 'ffmpeg is not installed or not in PATH.' };
  }
}

export async function transcribeLocal(jobId, input) {
  const { audioPath, language, model, vadFilter } = input;

  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.available) {
    // faster-whisper decodes audio through bundled PyAV, so a system ffmpeg
    // is optional. Keep going and let the worker report any real decode error.
    console.warn(`[local] ${ffmpeg.message || 'ffmpeg not found'} Continuing with PyAV decoding.`);
  }

  const outputFile = path.resolve(config.tmpDir, `${jobId}.segments.json`);
  const inputFile = path.resolve(config.tmpDir, `${jobId}.input.json`);
  for (const file of [outputFile, inputFile]) {
    try {
      await fs.unlink(file);
    } catch {
      // ignore
    }
  }

  const inputData = {
    audioPath,
    language: language || 'auto',
    model: model || config.localDefaultModel,
    vadFilter: vadFilter !== false,
    output: outputFile,
  };

  // The worker reads a JSON *file*, not an inline JSON argument. Passing the
  // payload inline made Windows fail with [Errno 22] Invalid argument because
  // the payload contains ", { and } which are illegal in file names.
  await fs.writeFile(inputFile, JSON.stringify(inputData), 'utf8');

  return new Promise((resolve, reject) => {
    mark(jobId, { status: 'transcribing', message: 'Starting local transcription…' });
    const proc = spawn(
      config.localPython,
      [workerPath, '--input', inputFile],
      {
        cwd: config.srcDir,
        env: process.env,
        windowsHide: true,
      },
    );

    let stderr = '';
    let lastStderrMark = -1;
    proc.stdout.on('data', (data) => {
      const text = String(data);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const payload = JSON.parse(trimmed);
          if (payload.type === 'progress' && typeof payload.progress === 'number') {
            mark(jobId, { progress: Math.min(99, payload.progress * 100), message: payload.message || '' });
          } else if (payload.type === 'info') {
            // model/language selection acknowledged — surface accuracy notes
            if (payload.note) {
              mark(jobId, { message: payload.note });
            }
          } else if (payload.type === 'error') {
            reject(new Error(payload.error || 'Local transcription failed.'));
          }
        } catch {
          // ignore non-JSON stdout lines
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += String(data);
      // Model download happens here (tqdm writes \r-prefixed lines). Surface a
      // throttled progress hint so the UI is never a silent black box.
      const m = String(data).match(/(\d{1,3})%/, 1000);
      if (m) {
        const pct = Number(m[1]);
        if (lastStderrMark !== pct) {
          lastStderrMark = pct;
          mark(jobId, { progress: Math.min(35, 15 + pct / 2), message: 'Downloading model… ' + pct + '%' });
        }
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', async (code) => {
      try {
        await fs.unlink(inputFile);
      } catch {
        // ignore cleanup
      }

      if (code !== 0) {
        reject(new Error(`Local transcription exited with code ${code}. ${stderr ? stderr.slice(0, 400) : ''}`));
        return;
      }

      try {
        const raw = await fs.readFile(outputFile, 'utf8');
        const result = JSON.parse(raw);
        const segments = Array.isArray(result.segments)
          ? result.segments.map((s) => ({
              start: Number(s.start),
              end: Number(s.end),
              text: String(s.text || '').trim(),
            })).filter((s) => s.text.length > 0)
          : [];

        const text = String(result.text || segments.map((s) => s.text).filter(Boolean).join(' '));
        const duration = result.duration ?? null;
        const detectedLanguage = (result.language ?? language) || 'auto';

        const noSpeech = segments.length === 0;
        const t = result.timings || {};
        const timingNote = (t.modelLoad != null && t.transcribe != null)
          ? ` Model load ${t.modelLoad}s · transcribe ${t.transcribe}s.`
          : '';
        mark(jobId, {
          status: 'completed',
          segments,
          text,
          duration,
          detectedLanguage,
          progress: 100,
          message: (noSpeech
            ? 'Finished, but no speech was detected. Check the file has audible speech, or try a larger model.'
            : 'Transcription complete.') + timingNote,
        });
        resolve();
      } catch (err) {
        reject(new Error('Local transcription completed but output file was invalid.'));
      } finally {
        try {
          await fs.unlink(outputFile);
        } catch {
          // ignore cleanup
        }
      }
    });
  });
}
