import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';

try {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
} catch {
  // directory is created later by ensureDirs()
}

const allowedExtensions = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.flv', '.webm', '.3gp',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus',
]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, config.uploadsDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = allowedExtensions.has(ext) ? ext : '.bin';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  const mimeOk = mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/octet-stream';

  if (!allowedExtensions.has(ext) && !mimeOk) {
    return cb(new Error('Unsupported file type. Upload a video or audio file.'));
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: 1,
  },
  fileFilter,
});
