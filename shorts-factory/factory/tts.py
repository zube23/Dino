"""Line-by-line speech synthesis with Piper.

Each spoken line becomes its own WAV so the timeline knows exact durations —
captions, jaw animation and sound effects stay perfectly in sync.
"""
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import wave

import numpy as np

from . import config

_voice = None


def ensure_voice_model():
    if os.path.exists(config.VOICE_ONNX):
        return
    os.makedirs(config.VOICE_DIR, exist_ok=True)
    print(f"[tts] downloading voice model ({config.VOICE_URL}) ...", flush=True)
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        urllib.request.urlretrieve(config.VOICE_URL, tmp.name)
        with tarfile.open(tmp.name) as tar:
            tar.extractall(config.VOICE_DIR)
    os.unlink(tmp.name)
    print("[tts] voice model ready", flush=True)


def _load():
    global _voice
    if _voice is None:
        ensure_voice_model()
        from piper import PiperVoice
        _voice = PiperVoice.load(config.VOICE_ONNX)
    return _voice


def synth_line(text):
    """Return (samples float32 mono in [-1,1], sample_rate)."""
    voice = _load()
    from piper.config import SynthesisConfig
    cfg = SynthesisConfig(speaker_id=config.SPEAKER_ID, length_scale=config.LENGTH_SCALE)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        voice.synthesize_wav(text, w, syn_config=cfg)
    buf.seek(0)
    with wave.open(buf, "rb") as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    x = pcm.astype(np.float32) / 32768.0
    # trim leading/trailing silence below -46 dB, keep small pad
    mask = np.abs(x) > 0.005
    if mask.any():
        i0, i1 = np.argmax(mask), len(mask) - np.argmax(mask[::-1])
        pad = int(0.04 * sr)
        x = x[max(0, i0 - pad):min(len(x), i1 + pad)]
    return x, sr


def synth_script_lines(texts):
    """Synthesize every line; returns list of (samples, sr, duration_seconds)."""
    out = []
    for t in texts:
        x, sr = synth_line(t)
        out.append((x, sr, len(x) / sr))
    return out
