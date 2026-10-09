import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { ensureDirs } from './paths.js';
import { jobs } from './jobs-store.js';
import { originMiddleware } from './middleware/origin.js';
import { upload } from './middleware/upload.js';
import { jobsRouter } from './routes/jobs.js';
import { healthRouter } from './routes/health.js';

export async function createApp() {
  await ensureDirs();
  await jobs.init();

  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));

  app.use(originMiddleware);

  app.use('/uploads', express.static(config.uploadsDir, { index: false }));

  app.use(express.static(config.publicDir, { index: 'index.html' }));

  app.use('/api', healthRouter);
  app.use('/api', jobsRouter);

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message || 'Request failed' });
    }
    next();
  });

  return app;
}