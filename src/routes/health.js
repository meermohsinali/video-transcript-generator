import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { config } from '../config.js';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';
const ffmpegCommand = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
const ffmpegStaticPath = path.resolve(config.srcDir, '..', 'node_modules', 'ffmpeg-static', isWindows ? 'ffmpeg.exe' : 'ffmpeg');

async function checkFfmpeg() {
  try {
    await execFileAsync(ffmpegCommand, ['-version'], { timeout: 5000 });
    return { available: true, message: 'ffmpeg found in system PATH' };
  } catch {
    try {
      if (fs.existsSync(ffmpegStaticPath)) {
        return { available: true, message: 'ffmpeg-static is available in node_modules' };
      }
    } catch {
      // ignore
    }
    return { available: false, message: 'ffmpeg not found in PATH or node_modules' };
  }
}

async function checkGeminiConfigured() {
  const key = process.env.GEMINI_API_KEY || '';
  return { configured: key.length >= config.geminiMinKeyLength, message: key ? 'Gemini API key present' : 'No Gemini API key set' };
}

async function checkLocalWhisper() {
  try {
    await execFileAsync(config.localPython, ['-c', 'import faster_whisper'], { timeout: 8000 });
    return { available: true, message: `faster-whisper is installed for ${config.localPython}.` };
  } catch {
    return {
      available: false,
      message: `faster-whisper is not installed for ${config.localPython}. Run setup-local.ps1, or: pip install faster-whisper`,
    };
  }
}

export async function healthMiddleware(req, res) {
  const [ffmpeg, gemini, whisper] = await Promise.all([
    checkFfmpeg(),
    checkGeminiConfigured(),
    checkLocalWhisper(),
  ]);

  res.json({
    ok: true,
    ffmpeg: ffmpeg.available,
    ffmpegMessage: ffmpeg.available
      ? ffmpeg.message
      : `${ffmpeg.message}. Optional: faster-whisper decodes audio with its bundled PyAV, so system ffmpeg is not required.`,
    local: whisper,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxDurationSeconds: config.maxJobDurationSeconds,
    },
    geminiConfigured: gemini.configured,
    geminiMessage: gemini.message,
  });
}

const router = Router();
router.get('/health', healthMiddleware);

export { router as healthRouter };
