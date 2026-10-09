import http from 'node:http';
import { config } from './src/config.js';
import { createApp } from './src/app.js';

async function main() {
  const app = await createApp();
  const server = http.createServer(app);

  server.listen(config.port, () => {
    console.log(`LingoScribe is running at http://localhost:${config.port}`);
    console.log('API docs: POST /api/jobs | GET /api/health');
  });
}

main().catch((err) => {
  console.error('Failed to start LingoScribe:', err);
  process.exit(1);
});