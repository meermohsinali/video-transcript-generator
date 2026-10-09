# Lightweight image: Node only (Google Gemini engine).
# Builds in ~1-2 min so it fits Hugging Face's free tier. The LOCAL
# faster-whisper engine is NOT available in this image (it needs Python +
# ffmpeg + a large model). For the full local+Gemini image see `Dockerfile.full`
# and deploy that on Railway / Fly / Cloud Run instead.
FROM node:20-bookworm-slim

WORKDIR /app

# Node dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Application code.
COPY . .

ENV NODE_ENV=production \
    PORT=7860 \
    ALLOWED_ORIGIN=*

EXPOSE 7860
CMD ["node", "server.js"]

