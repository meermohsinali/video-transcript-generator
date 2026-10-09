# LingoScribe — Video / Audio Transcript Generator

Upload a video or audio file and get an accurate transcript in **English, Urdu (Nastaliq), Roman Urdu, Hindi (Devanagari), Roman Hindi**. Each language version is generated on demand with a single click and can be downloaded as **TXT / SRT / VTT**.

Built with Node.js (Express) + Google Gemini, plus an optional local engine (faster-whisper).

---

## Features
- One upload → transcript, then switch language anytime (Urdu / Roman Urdu / Hindi / Roman Hindi / English).
- Timings preserved exactly in every language; edit segments, then re-export SRT/VTT.
- **Google Gemini** engine: fast (a 30-min video ≈ 2–5 min) and accurate for Urdu/Hindi.
- **Local** engine (faster-whisper) for offline English; `large-v3-turbo` for Urdu/Hindi.
- Copy, download TXT/SRT/VTT, resumable chunked upload to Google.

---

## Run locally (your PC)
Requirements: Node 18+, and for the **local** engine only: Python 3.11 + `ffmpeg`.

```bash
npm install
npm start          # http://localhost:3000
```

Windows shortcut: double-click **`start.bat`**.

Local engine setup (optional):
```bash
npm run setup-local          # creates a Python venv + installs faster-whisper
set GEMINI_LOCAL_PYTHON=<path-to-venv-python>   # optional
```

---

## Deploy live (recommended: Render + Gemini)

> **Note on Vercel:** this app is a long-running Node server + Python, which
> Vercel's serverless platform does not support (jobs are killed at ~60s and
> there is no persistent storage). Use **Render** or **Railway** instead — both
> host the full app and give you a real live link.

### Option A — Render (free, Gemini engine) — simplest
1. Push this repo to GitHub.
2. Go to https://dashboard.render.com → **New +** → **Blueprint** → pick this repo.
   (`render.yaml` is already configured.)
3. Deploy. Render gives you a public `https://…onrender.com` link.
4. Open the link, paste your **Gemini API key** in the field, choose **Google Gemini**, and transcribe.

No environment variables or secrets are required on the server — the Gemini API
key is entered in the browser and never stored on disk.

### Option B — Railway (Docker: local + Gemini)
This builds `Dockerfile` (Node + Python + ffmpeg + faster-whisper), so the
**local** engine also works in the cloud. Requires a plan with enough RAM
(large-v3-turbo needs ~2–3 GB).

1. Push this repo to GitHub.
2. https://railway.com → **New Project** → **Deploy from GitHub** → pick this repo.
3. Railway detects the `Dockerfile` and builds it automatically.
4. Open the generated `https://…up.railway.app` link.

---

## API
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | server + engine status |
| POST | `/api/jobs` | upload a file and start a transcription job |
| GET | `/api/jobs/:id` | poll job progress / result |
| PATCH | `/api/jobs/:id` | edit transcript segments |
| POST | `/api/jobs/:id/variant` | build a language version (Urdu/Roman Urdu/Hindi/…) |
| GET | `/api/jobs/:id/export?format=txt\|srt\|vtt` | download |

---

## Tests
```bash
npm test
```

## License
MIT
