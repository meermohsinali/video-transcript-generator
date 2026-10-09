#!/usr/bin/env python3
import sys
import json
import os
import time
import traceback

try:
    from faster_whisper import WhisperModel
    HAS_FASTER_WHISPER = True
except Exception as exc:
    HAS_FASTER_WHISPER = False

def read_payload(argv):
    """Accept either a JSON file path or the JSON text itself."""
    raw = argv[2]
    try:
        return json.loads(raw)
    except Exception:
        pass
    with open(raw, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def main():
    if len(sys.argv) < 3 or sys.argv[1] != '--input':
        print(json.dumps({'type': 'error', 'error': 'Bad arguments. Use --input <json-file>.'}), flush=True)
        sys.exit(1)

    try:
        data = read_payload(sys.argv)
    except Exception as exc:
        print(json.dumps({'type': 'error', 'error': f'Could not read input payload: {exc}'}), flush=True)
        sys.exit(1)

    audio_path = data.get('audioPath')
    language = data.get('language', 'auto') or 'auto'
    model = data.get('model', 'base') or 'base'
    vad_filter = bool(data.get('vadFilter', True))
    output_path = data.get('output')

    if not audio_path or not os.path.exists(audio_path):
        print(json.dumps({'type': 'error', 'error': f'Audio file not found: {audio_path}'}), flush=True)
        sys.exit(1)
    if not output_path:
        print(json.dumps({'type': 'error', 'error': 'Missing "output" path in payload.'}), flush=True)
        sys.exit(1)

    # faster-whisper auto-detects when language is None. 'auto' is not a valid
    # language code and would raise ValueError inside transcribe().
    whisper_language = None if str(language).lower() in ('auto', 'none', '') else language

    print(json.dumps({'type': 'info', 'model': model, 'language': language, 'vadFilter': vad_filter}), flush=True)

    # Honest accuracy warning: on this hardware the only accurate local model
    # for Urdu/Hindi is large-v3-turbo, and it is extremely slow (measured
    # ~0.05x realtime on a 4-core CPU). base/small/tiny are fast but produce
    # garbled Nastaliq/Devanagari. Surface this so the result is never a silent
    # surprise, and point to Gemini for fast + accurate output.
    lang_key = str(language).lower()
    model_key = str(model).lower()
    is_large = ('large' in model_key) or ('turbo' in model_key) or ('medium' in model_key)
    if lang_key in ('ur', 'hi') and not is_large:
        print(json.dumps({'type': 'info', 'note':
            'Note: base/small are fast but often wrong for Urdu/Hindi. For accuracy '
            'use Google Gemini (fast + correct), or select the large-v3-turbo model '
            '(accurate but very slow on this PC).'}), flush=True)

    if not HAS_FASTER_WHISPER:
        msg = ('faster-whisper is not installed for this Python. '
               'Run setup-local.ps1, or: pip install faster-whisper')
        print(json.dumps({'type': 'error', 'error': msg}), flush=True)
        sys.exit(1)

    # Language-specific priming text. Whisper heavily biases its output toward
    # whatever script it was primed with, so this keeps Urdu in clean Nastaliq
    # and Hindi in clean Devanagari instead of the mixed-up text it otherwise
    # produces on accented/mixed speech.
    INITIAL_PROMPTS = {
        'ur': 'یہ اردو ہے۔ کیسے ہو؟ آپ کا دن اچھا گزرے۔ یہ جملہ صرف اردو میں لکھا جائے گا۔',
        'hi': 'यह हिन्दी है। आप कैसे हैं? आपका दिन शुभ रहे। यह वाक्य केवल देवनागरी में लिखा जाएगा।',
        'en': 'This is an English sentence. Hello, how are you doing today?',
        'auto': 'یہ اردو ہے۔ यह हिन्दी है। This is English.',
    }
    initial_prompt = INITIAL_PROMPTS.get(str(language).lower())

    try:
        # cpu_threads: use every core — for a 30 min video this roughly halves
        # wall-clock time on a typical desktop vs. the default single thread.
        t_load_start = time.time()
        model_instance = WhisperModel(
            model,
            device='cpu',
            compute_type='int8',
            cpu_threads=max(1, os.cpu_count() or 1),
        )
        load_seconds = round(time.time() - t_load_start, 1)
        print(json.dumps({'type': 'progress', 'progress': 0.1, 'message': f'Model loaded in {load_seconds}s'}), flush=True)

        transcribe_kwargs = {
            'language': whisper_language,
            'beam_size': 5,
            'vad_filter': vad_filter,
            # Stops the classic Whisper failure mode seen on this machine:
            # after a mistake it repeats itself forever ("لیکن پر میشن کی...").
            # Continuing from its own previous text is what fuels those loops.
            'condition_on_previous_text': False,
            'initial_prompt': initial_prompt,
            'compression_ratio_threshold': 2.4,
            'log_prob_threshold': -1.0,
            'no_speech_threshold': 0.5,
            # temperature=0 disables faster-whisper's default retry ladder
            # (0.0 -> 1.0). On noisy audio every bad segment used to be decoded
            # up to 6 times, which stalled jobs for minutes. One clean pass.
            'temperature': 0,
        }

        segments, info = model_instance.transcribe(audio_path, **transcribe_kwargs)

        t_transcribe_start = time.time()
        print(json.dumps({'type': 'progress', 'progress': 0.5, 'message': 'Transcribing'}), flush=True)

        result_segments = []
        # transcribe() returns a generator, so len() is not available. Estimate
        # progress from the audio duration instead.
        total_duration = float(getattr(info, 'duration', 0) or 0) or None
        count = 0
        for segment in segments:
            count += 1
            result_segments.append({
                'start': round(segment.start, 3),
                'end': round(segment.end, 3),
                'text': (segment.text or '').strip(),
            })
            if count % 2 == 0:
                if total_duration:
                    ratio = min(1.0, max(0.0, segment.end / total_duration))
                else:
                    ratio = min(1.0, count / 100)
                print(json.dumps({
                    'type': 'progress',
                    'progress': round(0.5 + 0.45 * ratio, 4),
                    'message': f'{count} segments · {segment.end:.0f}s of audio done',
                }), flush=True)

        if not result_segments:
            result_segments = [{'start': 0.0, 'end': 0.0, 'text': ''}]

        text = ' '.join(s['text'] for s in result_segments if s['text'])
        duration = round(info.duration, 3) if info and info.duration else None
        transcribe_seconds = round(time.time() - t_transcribe_start, 1)

        payload = {
            'segments': result_segments,
            'text': text,
            'duration': duration,
            'language': info.language if info and info.language else language,
            'model': model,
            'timings': {'modelLoad': load_seconds, 'transcribe': transcribe_seconds},
        }

        tmp_path = output_path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, output_path)
        print(json.dumps({'type': 'progress', 'progress': 1.0, 'message': 'Done'}), flush=True)

    except Exception as exc:
        print(json.dumps({
            'type': 'error',
            'error': str(exc),
            'traceback': traceback.format_exc()[-800:],
        }), flush=True)
        sys.exit(1)

if __name__ == '__main__':
    main()