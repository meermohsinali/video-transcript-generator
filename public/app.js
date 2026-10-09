"use strict";

const state = {
  jobId: null,
  status: null,
  progress: 0,
  fileName: '',
  filesize: 0,
  abortController: null,
  pollTimer: null,
  done: false,
  segments: [],
  text: '',
  detectedLanguage: '',
  variants: {},
  activeLang: 'original',
  viewSegments: [],
  viewText: '',
  viewEditable: true,
  variantBusy: false,
};

const LANG_LABELS = {
  original: 'Original',
  en: 'English',
  ur: 'Urdu',
  ur_roman: 'Roman Urdu',
  hi: 'Hindi',
  hi_roman: 'Roman Hindi',
};

const LOCAL_MODELS = ['base', 'small', 'tiny', 'medium', 'large-v3', 'large-turbo'];
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

function syncProviderUI() {
  const provider = $('provider') ? $('provider').value : 'local';
  const modelSel = $('model');
  if (!modelSel) return;
  const wanted = provider === 'gemini' ? GEMINI_MODELS : LOCAL_MODELS;
  const current = modelSel.value;
  modelSel.innerHTML = '';
  wanted.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name === wanted[0] ? `${name} (recommended)` : name;
    modelSel.appendChild(option);
  });
  if (wanted.includes(current)) modelSel.value = current;
}

const $ = (id) => document.getElementById(id);

function showEl(id, on) {
  const el = $(id);
  if (el) el.classList.toggle('hidden', !on);
}

function setError(msg) {
  const banner = $('errorBanner');
  const text = $('errorText');
  if (banner) banner.classList.remove('hidden');
  if (text) text.textContent = msg;
}

function clearError() {
  const banner = $('errorBanner');
  if (banner) banner.classList.add('hidden');
}

function readFileStats(file) {
  state.fileName = file.name;
  state.filesize = file.size;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  const info = $('fileInfo');
  if (info) info.textContent = 'Selected: ' + file.name + ' (' + mb(file.size) + ' MB)';
}

async function postJob(file, provider, language, model, apiKey, cloudConsent) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('provider', provider);
  fd.append('language', language);
  fd.append('model', model);
  fd.append('apiKey', apiKey);
  fd.append('cloudConsent', cloudConsent);

  state.abortController = new AbortController();
  const res = await fetch('/api/jobs', {
    method: 'POST',
    body: fd,
    signal: state.abortController.signal,
  });
  if (!res.ok) {
    let msg = 'Upload failed (' + res.status + ').';
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const job = await res.json();
  state.jobId = job.id;
  state.status = job.status;
  showEl('jobSection', true);
  $('jobId').textContent = 'Job #: ' + job.id;
  $('jobStatus').textContent = job.status || 'Queued';
  $('jobMessage').textContent = withElapsed(job);
  $('progressBar').style.width = '0%';
  $('progressPercent').textContent = '0%';
  $('cancelButton').hidden = false;
  $('pollAgainButton').hidden = true;
  startPolling();
  return job;
}

// Shows how long the current job has been running so the loading state never
// looks frozen. Uses the server-provided createdAt (same machine, localhost).
function withElapsed(job) {
  const base = job.message || '';
  if (!job.createdAt) return base;
  const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  if (terminal) return base;
  const secs = Math.max(0, Math.round((Date.now() - job.createdAt) / 1000));
  return base ? base + ' · ' + secs + 's' : secs + 's';
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {

    if (!state.jobId) return;
    try {
      const res = await fetch('/api/jobs/' + state.jobId, { signal: state.abortController.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error) setError(data.error);
        return;
      }
      const job = await res.json();
      state.status = job.status;
      state.progress = job.progress != null ? job.progress : 0;
      $('jobStatus').textContent = job.status || 'Queued';
      $('jobMessage').textContent = withElapsed(job);
      $('progressBar').style.width = Math.min(100, Math.max(0, state.progress)) + '%';
      $('progressPercent').textContent = Math.round(state.progress) + '%';

      if (job.status === 'completed') {
        clearError();
        stopPolling();
        showEl('resultSection', true);
        finishJob(job);
        return;
      }
      if (job.status === 'cancelled' || job.status === 'failed') {
        clearError();
        stopPolling();
        if (job.status === 'failed') setError(job.error || 'Transcription failed.');
        $('pollAgainButton').hidden = false;
        return;
      }
      if (job.segments && job.segments.length) {
        renderPartial(job.segments, job.text || '', job.status);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      clearError();
      setError('Polling error: ' + err.message);
    }
  }, 1500);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function renderPartial(segments, text, status) {
  if (state.done) return;
  state.done = true;
  state.segments = segments;
  state.text = text;
  renderSegmentList(segments, { editable: false });
  paintTranscript(text);
}

function renderSegmentList(segments, options) {
  const editable = Boolean(options && options.editable);
  const list = $('segmentList');
  if (!list) return;
  list.innerHTML = '';
  segments.forEach((s, idx) => {
    const li = document.createElement('li');
    li.className = 'segment';
    const time = document.createElement('div');
    time.className = 'segment-time';
    time.textContent = formatTime(s.start) + ' -> ' + formatTime(s.end);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.text || '';
    input.dataset.index = String(idx);
    input.disabled = !editable;
    input.readOnly = !editable;
    li.appendChild(time);
    li.appendChild(input);
    list.appendChild(li);
  });
}

function renderSegments(segments, editable) {
  renderSegmentList(segments, { editable: editable !== false });
}

function paintTranscript(text) {
  const el = $('transcriptText');
  if (el) el.textContent = text || '';
  renderSubtitlePreview(state.viewSegments && state.viewSegments.length ? state.viewSegments : state.segments);
}

function renderSubtitlePreview(segments) {
  const pre = $('subtitlePreview');
  if (!pre) return;
  pre.textContent = buildSrt(segments || []);
}

function buildSrt(segments) {
  return segments
    .map((s, i) => {
      const pad = (n, w) => String(Math.floor(n)).padStart(w, '0');
      const start = `${pad(s.start / 3600, 2)}:${pad((s.start / 60) % 60, 2)}:${pad(s.start % 60, 2)},${String(Math.floor((s.start % 1) * 1000)).padStart(3, '0')}`;
      const end = `${pad(s.end / 3600, 2)}:${pad((s.end / 60) % 60, 2)}:${pad(s.end % 60, 2)},${String(Math.floor((s.end % 1) * 1000)).padStart(3, '0')}`;
      return `${i + 1}\n${start} --> ${end}\n${s.text}\n`;
    })
    .join('\n');
}

function isOriginalEnglish() {
  const code = String(state.detectedLanguage || '').toLowerCase();
  return code === 'en' || code === 'english';
}

function setLangStatus(msg) {
  const el = $('langStatus');
  if (el) el.textContent = msg || '';
}

function setActiveLangButton(lang) {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
}

function setLanguageButtonsDisabled(disabled) {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.disabled = disabled;
  });
}

function showView(view) {
  state.viewSegments = view.segments || [];
  state.viewText = view.text || '';
  state.viewEditable = Boolean(view.editable);
  renderSegmentList(state.viewSegments, { editable: state.viewEditable });
  paintTranscript(state.viewText);
  const count = $('segmentCount');
  if (count) count.textContent = state.viewSegments.length + ' segments';
  const save = $('saveEditsButton');
  if (save) save.hidden = !state.viewEditable;
}

function finishJob(job) {
  state.done = true;
  state.segments = job.segments || [];
  state.text = job.text || '';
  state.detectedLanguage = job.detectedLanguage || job.language || '';
  state.variants = {};
  state.activeLang = 'original';

  const detected = $('detectedLang');
  if (detected) detected.textContent = state.detectedLanguage || 'auto';

  const originalBtn = $('langOriginal');
  if (originalBtn) originalBtn.hidden = isOriginalEnglish();

  setActiveLangButton(isOriginalEnglish() ? 'en' : 'original');
  const keyInput = $('apiKey');
  const hasKey = Boolean(keyInput && keyInput.value.trim().length >= 20);
  setLangStatus(hasKey
    ? ''
    : 'Tip: Urdu / Roman Urdu / Hindi / Roman Hindi / English versions are built with Google Gemini — paste a Gemini API key in the field above once (it will be remembered in this browser).');
  showView({ segments: state.segments, text: state.text, editable: true });

  ['exportTxt', 'exportSrt', 'exportVtt', 'copyTextButton', 'copyBottomButton'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = false;
  });
  const copyBtn = $('copyTextButton');
  if (copyBtn) copyBtn.disabled = false;
}

async function fetchVariant(lang) {
  // Timeouts matter: without one, a hung Google call leaves every language
  // button permanently disabled ("Building… forever).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch('/api/jobs/' + state.jobId + '/variant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lang,
        apiKey: ($('apiKey') ? $('apiKey').value.trim() : ''),
        model: $('model') ? $('model').value : '',
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Could not build the ' + (LANG_LABELS[lang] || lang) + ' version.');
      err.code = data.code || '';
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Google took too long to build the ' + (LANG_LABELS[lang] || lang) + ' version (90 seconds). Please try again.');
      timeoutErr.code = 'TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function selectLanguage(lang) {
  if (!state.jobId || !state.done || state.variantBusy) return;
  clearError();

  const isOriginalView = lang === 'original' || (lang === 'en' && isOriginalEnglish());
  if (isOriginalView) {
    state.activeLang = lang;
    setActiveLangButton(lang);
    setLangStatus('');
    showView({ segments: state.segments, text: state.text, editable: true });
    return;
  }

  const cached = state.variants[lang];
  if (cached) {
    state.activeLang = lang;
    setActiveLangButton(lang);
    setLangStatus('');
    showView({ segments: cached.segments, text: cached.text, editable: false });
    return;
  }

  state.activeLang = lang;
  setActiveLangButton(lang);
  state.variantBusy = true;
  setLanguageButtonsDisabled(true);
  setLangStatus('Building the ' + LANG_LABELS[lang] + ' version…');

  try {
    const data = await fetchVariant(lang);
    state.variants[lang] = data;
    setLangStatus(data.partial
      ? LANG_LABELS[lang] + ' ready (a few lines kept the original wording).'
      : LANG_LABELS[lang] + ' ready.');
    showView({ segments: data.segments, text: data.text, editable: false });
  } catch (err) {
    setError(err.message);
    // Show the failure right under the language buttons too — the top error
    // banner is off-screen when the user is down here clicking languages.
    setLangStatus('⚠ ' + err.message);
    if (err.code === 'NEEDS_API_KEY' && $('apiKey')) {
      $('apiKey').focus();
    }
    state.activeLang = isOriginalEnglish() ? 'en' : 'original';
    setActiveLangButton(state.activeLang);
    showView({ segments: state.segments, text: state.text, editable: true });
  } finally {
    state.variantBusy = false;
    setLanguageButtonsDisabled(false);
  }
}

function formatTime(sec) {
  if (!sec && sec !== 0) return '...';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getSegmentsFromDOM() {
  const list = $('segmentList');
  const out = [];
  if (!list) return out;
  list.querySelectorAll('input').forEach((input) => {
    const text = input.value.trim();
    const idx = Number(input.dataset.index);
    const source = state.segments[idx];
    if (!text) return;
    out.push({
      start: source && typeof source.start === 'number' ? source.start : 0,
      end: source && typeof source.end === 'number' ? source.end : 0,
      text,
    });
  });
  return out;
}

async function patchSegments(segments) {
  if (!state.jobId) return;
  const res = await fetch('/api/jobs/' + state.jobId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Edit failed');
  }
  const job = await res.json();
  state.segments = job.segments || [];
  state.text = job.text || '';
  state.variants = {};
  showView({ segments: state.segments, text: state.text, editable: true });
  return job;
}

async function runExport(format) {
  clearError();
  try {
    await exportFile(format);
  } catch (err) {
    setError(err.message);
  }
}

async function exportFile(format) {
  if (!state.jobId) return;
  const lang = state.activeLang || 'original';
  const res = await fetch(
    '/api/jobs/' + state.jobId + '/export?format=' + format + '&lang=' + encodeURIComponent(lang),
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transcript.' + format;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  if (!text) {
    setError('Nothing to copy yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    [$('copyTextButton'), $('copyBottomButton')].forEach((btn) => {
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  } catch (e) {
    setError('Clipboard not available. Select the text and copy manually.');
  }
}

async function onSubmit(e) {
  e.preventDefault();
  clearError();
  const file = $('fileInput').files[0];
  if (!file) {
    setError('Choose a video or audio file first.');
    return;
  }
  if (state.done) {
    setError('Please wait for the current job to finish before starting a new one.');
    return;
  }
  const provider = $('provider').value;
  const language = $('language').value;
  const model = $('model').value;
  const apiKey = $('apiKey').value.trim();
  const cloudConsent = $('cloudConsent').checked;

  if (provider === 'gemini' && !cloudConsent) {
    setError('You must agree that cloud audio is sent to Google.');
    return;
  }
  showEl('resultSection', false);
  showEl('jobSection', true);
  setError('');
  try {
    await postJob(file, provider, language, model, apiKey, cloudConsent);
  } catch (err) {
    setError(err.message);
    showEl('jobSection', false);
  }
}

function bindEvents() {
  const form = $('uploadForm');
  if (form) form.addEventListener('submit', onSubmit);

  $('cancelButton').addEventListener('click', async () => {
    if (!state.jobId) return;
    try {
      await fetch('/api/jobs/' + state.jobId + '/cancel', { method: 'POST' });
      setError('Cancellation requested. Waiting for server to stop.');
    } catch (err) {
      setError('Cancel failed: ' + err.message);
    }
  });

  $('pollAgainButton').addEventListener('click', async () => {
    clearError();
    showEl('jobSection', true);
    $('pollAgainButton').hidden = true;
    try {
      const res = await fetch('/api/jobs/' + state.jobId);
      if (!res.ok) throw new Error('Job not found');
      const job = await res.json();
      state.status = job.status;
      state.progress = job.progress != null ? job.progress : 0;
      $('jobStatus').textContent = job.status || 'Queued';
      $('jobMessage').textContent = withElapsed(job);
      $('progressBar').style.width = Math.min(100, Math.max(0, state.progress)) + '%';
      $('progressPercent').textContent = Math.round(state.progress) + '%';
      if (job.status === 'completed') {
        stopPolling();
        showEl('resultSection', true);
        finishJob(job);
        return;
      }
      startPolling();
    } catch (err) {
      setError('Retry failed: ' + err.message);
    }
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tabpanel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.querySelector('[data-panel="' + btn.dataset.tab + '"]');
      if (panel) panel.classList.add('active');
    });
  });

  $('saveEditsButton').addEventListener('click', async () => {
    const segments = getSegmentsFromDOM();
    if (!segments.length) {
      setError('Your edited transcript is empty.');
      return;
    }
    try {
      clearError();
      await patchSegments(segments);
      setLangStatus('Edits saved. Language versions were refreshed.');
    } catch (err) {
      setError(err.message);
    }
  });

  $('exportTxt').addEventListener('click', () => runExport('txt'));
  $('exportSrt').addEventListener('click', () => runExport('srt'));
  $('exportVtt').addEventListener('click', () => runExport('vtt'));

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectLanguage(btn.dataset.lang));
  });

  [$('copyTextButton'), $('copyBottomButton')].forEach((btn) => {
    if (btn) btn.addEventListener('click', () => copyText(state.viewText || ''));
  });
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json().catch(() => ({}));
    const msg = $('healthMessage');
    if (msg) {
      if (data.ok && data.local && data.local.available) {
        msg.textContent = 'Local transcription ready. ' + (data.ffmpeg ? '' : '(No system ffmpeg needed.)');
      } else if (data.local) {
        msg.textContent = data.local.message;
      } else if (data.ok && data.ffmpeg) {
        msg.textContent = 'Local ffmpeg found. Local transcription is ready when you run setup-local.ps1.';
      } else {
        msg.textContent = 'Local processing setup is recommended. ' + (data.ffmpegMessage || 'No local ffmpeg.');
      }
    }
  } catch (e) { /* server may not be running */ }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  checkHealth();
  syncProviderUI();
  if ($('provider')) $('provider').addEventListener('change', syncProviderUI);
  // Remember the Gemini API key in this browser only (localStorage), so the
  // language buttons keep working after a page reload without re-pasting it.
  try {
    const savedKey = localStorage.getItem('lingoscribe_gemini_key');
    if (savedKey && $('apiKey') && !$('apiKey').value) $('apiKey').value = savedKey;
  } catch (e) { /* storage disabled */ }
  if ($('apiKey')) {
    $('apiKey').addEventListener('change', () => {
      try {
        const v = $('apiKey').value.trim();
        if (v) localStorage.setItem('lingoscribe_gemini_key', v);
        else localStorage.removeItem('lingoscribe_gemini_key');
      } catch (e) { /* storage disabled */ }
    });
  }
  $('fileInput').addEventListener('change', () => {
    if ($('fileInput').files[0]) readFileStats($('fileInput').files[0]);
  });
});