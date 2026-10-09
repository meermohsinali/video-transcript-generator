# Full image: Node + Python (faster-whisper) + ffmpeg.
# Used by Railway / Fly / Cloud Run so the LOCAL engine also works in the cloud.
# For a lightweight Gemini-only deploy, use render.yaml (native Node) instead.
FROM node:20-bookworm-slim

# System dependencies: Python 3.11 (has wheels for av==16.1.0) + ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Python dependencies: faster-whisper with PyAV pinned to 16.1.0
# (av>=17 removed an API that faster-whisper 1.2.x relies on).
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      "faster-whisper==1.2.1" "av==16.1.0"

# Application code.
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    GEMINI_LOCAL_PYTHON=python3

EXPOSE 3000
CMD ["node", "server.js"]
