"""Facts-over-parkour format: build a timeline from a simple facts script.

Script shape (queue/scripts/*.json):
{
  "id": "...", "format": "facts", "stage": "parkour", "music": "drive",
  "title": "...", "description": "...", "tags": [...],
  "pack_title": "FEELS ILLEGAL TO KNOW",
  "hook": "These facts feel illegal to know.",
  "facts": ["...", "..."],
  "outro": "Follow for part two."
}

The narration is TTS'd line by line; each line is split into 1-3 word
chunks that pop on screen in sync with the voice (timing distributed by
character weight). Coin pickups in the 3D world happen on a fixed hop
grid, so their sounds are placed here too.
"""
import hashlib
import re

from . import config, tts

HOP = 0.380          # seconds per jump — keep in sync with renderer/parkour.html
COIN_EVERY = 5       # coin on every block where i % 5 == 2
BOOST_EVERY = 17     # boost pad where i % 17 == 9 (big flip jump)
GAP = 0.30           # pause between lines
ACCENTS = ["#FFD166", "#4FC3F7", "#FF5D8F", "#7CE577", "#C77DFF", "#FF9F5A"]


def _chunks_for(text, t0, dur):
    """Split a line into <=3-word chunks, timed by character weight."""
    words = text.split()
    groups = []
    cur = []
    for w in words:
        cur.append(w)
        if len(cur) == 3 or re.search(r"[.,!?:;—]$", w):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    weights = [sum(len(w) + 1 for w in g) for g in groups]
    total_w = sum(weights) or 1
    out = []
    acc = 0.0
    for g, w in zip(groups, weights):
        start = t0 + dur * acc / total_w
        acc += w
        end = t0 + dur * acc / total_w
        out.append([" ".join(g).rstrip(",;"), int(start * 1000), int(end * 1000)])
    return out


def build(script):
    lines = [("hook", script["hook"])]
    lines += [("fact", f) for f in script["facts"]]
    if script.get("outro"):
        lines.append(("outro", script["outro"]))

    n_facts = len(script["facts"])
    beats = []
    voice_events = []
    sfx_events = []
    t = 0.0
    fact_no = 0

    for kind, text in lines:
        x, sr = tts.synth_line(text)
        dur = len(x) / sr
        talk0 = t + config.TALK_LEAD
        voice_events.append((talk0, x, sr))

        if kind == "fact":
            fact_no += 1
            sfx_events.append((max(0.0, t - 0.05), "whoosh"))
            sfx_events.append((t + 0.02, "ding"))
        elif kind == "outro":
            sfx_events.append((max(0.0, t - 0.6), "riser"))
            sfx_events.append((t + 0.02, "boom"))

        accent = ACCENTS[fact_no % len(ACCENTS)]
        beat = {
            "t0": int(t * 1000),
            "t1": int((talk0 + dur + GAP) * 1000),
            "talk": [int(talk0 * 1000), int((talk0 + dur) * 1000)],
            "chunks": _chunks_for(text, talk0, dur),
            "accent": accent,
            "packTitle": script.get("pack_title", ""),
            "chipText": (
                "WAIT." if kind == "hook"
                else (f"FACT {fact_no}/{n_facts}" if kind == "fact" else "PART 2?")
            ),
            "isOutro": kind == "outro",
        }
        beats.append(beat)
        t = talk0 + dur + GAP

    total = t + config.TAIL_HOLD

    # coin pickups on the hop grid
    k = 2
    while k * HOP < total - 0.4:
        sfx_events.append((k * HOP, "coin"))
        k += COIN_EVERY
    # boost pads: the big flip jump launches from block k where k % 17 == 9
    k = 9
    while k * HOP < total - 0.8:
        sfx_events.append((k * HOP, "whoosh"))
        k += BOOST_EVERY

    seed = int(hashlib.sha1(script["id"].encode()).hexdigest()[:8], 16) & 0x7FFFFFFF
    timeline = {"beats": beats, "total": int(total * 1000), "seed": seed}
    return timeline, voice_events, sfx_events, total
