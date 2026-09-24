"""Fully synthesized soundtrack: lo-fi music bed + cartoon SFX + voice mix.

Everything is generated with numpy — no downloaded samples, no licensing risk.
Deterministic per video (seeded by the script id).
"""
import hashlib
import wave

import numpy as np

from . import config

SR = config.SAMPLE_RATE


def _t(dur):
    return np.arange(int(dur * SR)) / SR


def _env(n, attack=0.005, release=0.08):
    e = np.ones(n)
    a, r = int(attack * SR), int(release * SR)
    if a > 0:
        e[:a] = np.linspace(0, 1, a)
    if r > 0 and r < n:
        e[-r:] *= np.linspace(1, 0, r)
    return e


def _note(freq, dur, kind="sine", vol=1.0, decay=6.0):
    t = _t(dur)
    if kind == "sine":
        x = np.sin(2 * np.pi * freq * t)
    elif kind == "tri":
        x = 2 / np.pi * np.arcsin(np.sin(2 * np.pi * freq * t))
    elif kind == "saw":
        x = 2 * ((freq * t) % 1) - 1
    else:
        x = np.sin(2 * np.pi * freq * t)
    x = x * np.exp(-decay * t) * vol
    return x * _env(len(x))


def _noise(dur, vol=1.0, decay=18.0):
    t = _t(dur)
    x = np.random.default_rng(7).standard_normal(len(t))
    return x * np.exp(-decay * t) * vol * _env(len(x))


def _sum(*parts):
    """Sum arrays of different lengths, zero-padded to the longest."""
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[:len(p)] += p
    return out


def _lowpass(x, alpha=0.15):
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += alpha * (x[i] - acc)
        y[i] = acc
    return y


# ---------------- SFX ----------------

def sfx(name):
    if name == "ding":
        return 0.6 * (_note(1318, 0.5, vol=0.7, decay=5) + _note(1975, 0.5, vol=0.4, decay=7))
    if name == "boing":
        t = _t(0.45)
        f = 260 * np.exp(-3.2 * t) + 70
        wob = np.sin(2 * np.pi * np.cumsum(f) / SR + 5 * np.sin(2 * np.pi * 9 * t))
        return 0.55 * wob * np.exp(-5 * t) * _env(len(t))
    if name == "whoosh":
        t = _t(0.4)
        n = np.random.default_rng(3).standard_normal(len(t))
        n = _lowpass(n, 0.25)
        amp = np.sin(np.pi * np.clip(t / 0.4, 0, 1)) ** 1.5
        return 0.5 * n * amp
    if name == "thud":
        return _sum(0.9 * _note(72, 0.35, vol=1.0, decay=11), 0.3 * _noise(0.1, decay=45))
    if name == "pop":
        return _sum(0.5 * _note(420, 0.09, vol=1.0, decay=26), 0.2 * _noise(0.05, decay=70))
    if name == "gulp":
        t = _t(0.3)
        f = 380 * np.exp(-5 * t) + 85
        return 0.6 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-6 * t)
    if name == "creak":
        t = _t(0.9)
        f = 88 + 24 * np.sin(2 * np.pi * 2.4 * t)
        x = 2 * ((np.cumsum(f) / SR) % 1) - 1
        return 0.16 * _lowpass(x, 0.3) * _env(len(t), release=0.25)
    if name == "keys":
        rng = np.random.default_rng(11)
        out = np.zeros(int(1.1 * SR))
        for i in range(14):
            p = int(rng.uniform(0, 0.95) * SR)
            c = _noise(0.03, vol=0.5, decay=110)
            out[p:p + len(c)] += c
        return out * 0.6
    if name == "alarm":
        out = np.zeros(int(1.0 * SR))
        beep = _note(1970, 0.11, kind="tri", vol=0.5, decay=2)
        for i in range(5):
            p = int(i * 0.2 * SR)
            out[p:p + len(beep)] += beep
        return out
    if name == "party":
        seq = [(523, 0.0), (659, 0.09), (784, 0.18), (1047, 0.3)]
        out = np.zeros(int(0.9 * SR))
        for f, at in seq:
            n = _note(f, 0.45, kind="tri", vol=0.5, decay=6)
            p = int(at * SR)
            out[p:p + len(n)] += n
        return out
    if name == "shutter":
        return 0.5 * _noise(0.05, decay=80) + 0.3 * _note(2400, 0.05, vol=0.6, decay=40)
    if name == "wind":
        t = _t(1.4)
        n = np.random.default_rng(5).standard_normal(len(t))
        n = _lowpass(n, 0.12)
        amp = 0.25 + 0.2 * np.sin(2 * np.pi * 0.8 * t)
        return 0.5 * n * amp * _env(len(t), attack=0.2, release=0.4)
    return np.zeros(1)


# ---------------- music bed ----------------

PROGRESSIONS = [
    [57, 53, 48, 55],   # A F C G  (minor-ish, wry)
    [55, 52, 57, 50],   # G E A D
    [48, 55, 57, 53],   # C G A F
]
PENTA = [0, 3, 5, 7, 10]


def _midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def _place(buf, p, x, gain=1.0):
    """Add x into buf starting at sample p, clipping safely at the end."""
    if p < 0 or p >= len(buf):
        return
    seg = x[: len(buf) - p]
    buf[p:p + len(seg)] += gain * seg


def music_bed(total_sec, seed_text, bpm=92):
    seed = int(hashlib.sha1(seed_text.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    n = int(total_sec * SR)
    out = np.zeros(n)
    prog = PROGRESSIONS[seed % len(PROGRESSIONS)]

    nbeats = int(total_sec / beat) + 2
    kick = _note(54, 0.28, vol=0.9, decay=16)
    hat = _noise(0.05, vol=0.16, decay=60)
    clap = _lowpass(np.random.default_rng(9).standard_normal(int(0.09 * SR)), 0.5) * 0.2 * _env(int(0.09 * SR), release=0.06)

    for b in range(nbeats):
        p = int(b * beat * SR)
        if p >= n:
            break
        bar = b // 4
        pos = b % 4
        if pos in (0, 2):
            _place(out, p, kick)
        if pos in (1, 3):
            _place(out, p, clap)
        for h in range(2):
            hp = int((b + h * 0.5 + (0.06 if h else 0)) * beat * SR)
            _place(out, hp, hat)
        # bass on each beat
        root = prog[bar % len(prog)] - 24
        bnote = _note(_midi(root), beat * 0.9, kind="sine", vol=0.5, decay=3.5)
        _place(out, p, bnote)
        # sparse pluck melody on off-beats
        if rng.random() < 0.55:
            deg = PENTA[int(rng.integers(0, len(PENTA)))]
            m = prog[bar % len(prog)] + 12 + deg
            pl = _note(_midi(m), beat * 0.7, kind="tri", vol=0.16, decay=7)
            _place(out, p + int(beat * 0.5 * SR), pl)

    out = _lowpass(out, 0.35)
    # duck-free constant bed level; fade out at end
    fade = int(0.5 * SR)
    if n > fade:
        out[-fade:] *= np.linspace(1, 0, fade)
    return out


# ---------------- mixing ----------------

def resample(x, sr_from, sr_to=SR):
    if sr_from == sr_to:
        return x
    n_to = int(len(x) * sr_to / sr_from)
    return np.interp(np.linspace(0, len(x) - 1, n_to), np.arange(len(x)), x).astype(np.float32)


def mix(total_sec, voice_events, sfx_events, seed_text, out_path):
    """voice_events: [(t_sec, samples, sr)], sfx_events: [(t_sec, name)]"""
    n = int(total_sec * SR)
    master = np.zeros(n)

    music = music_bed(total_sec, seed_text)
    master[:len(music)] += 0.30 * music[:n]

    for t0, x, sr in voice_events:
        x = resample(x, sr)
        peak = np.max(np.abs(x)) or 1.0
        x = x / peak * 0.86
        p = int(t0 * SR)
        seg = x[:max(0, n - p)]
        master[p:p + len(seg)] += seg

    for t0, name in sfx_events:
        x = sfx(name)
        p = int(t0 * SR)
        seg = x[:max(0, n - p)]
        master[p:p + len(seg)] += 0.8 * seg

    # gentle limiter
    master = np.tanh(master * 1.15) * 0.92
    fade_in = int(0.03 * SR)
    master[:fade_in] *= np.linspace(0, 1, fade_in)

    pcm = (np.clip(master, -1, 1) * 32767).astype(np.int16)
    stereo = np.repeat(pcm[:, None], 2, axis=1)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(stereo.tobytes())
    return out_path
