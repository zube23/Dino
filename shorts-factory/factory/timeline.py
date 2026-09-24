"""Turn a sketch script (queue/scripts/*.json) into:
  - a timeline the renderer draws (absolute times, per-beat state)
  - voice + sfx event lists for the audio mixer
"""
from . import config, tts

AUTO_SFX = {
    "walkin": [("whoosh", 0.0)],
    "sadwalk": [("whoosh", 0.15)],
    "hop": [("boing", 0.05)],
    "celebrate": [("party", 0.0)],
    "eat": [("gulp", 0.62)],
    "smash": [("thud", 0.5)],
    "typing": [("keys", 0.1)],
    "reach": [("creak", 0.15)],
    "slump": [("thud", 0.55)],
}


def build(script):
    beats_in = script["beats"]
    texts = [b["say"] for b in beats_in if b.get("say")]
    synths = tts.synth_script_lines(texts)

    beats_out = []
    voice_events = []
    sfx_events = []
    t = 0.0
    vi = 0
    bg = "office"
    props = []

    for b in beats_in:
        bg = b.get("bg", bg)
        props = b.get("props", props)
        beat = {
            "bg": bg,
            "props": props,
            "mood": b.get("mood", "neutral"),
            "action": b.get("action", "idle"),
            "capStyle": b.get("capStyle", "say"),
        }
        for k in ("punch", "shake", "top", "ring", "hatFly", "fx", "pupDX"):
            if k in b:
                beat[k] = b[k]

        if b.get("say"):
            x, sr, dur = synths[vi]
            vi += 1
            talk0 = t + config.TALK_LEAD
            voice_events.append((talk0, x, sr))
            beat_dur = config.TALK_LEAD + dur + b.get("pause", config.DEFAULT_PAUSE_AFTER_SAY)
            beat["talk"] = [int(talk0 * 1000), int((talk0 + dur) * 1000)]
            beat["caption"] = b.get("caption", b["say"])
        else:
            beat_dur = b.get("dur", config.DEFAULT_BEAT_DUR)
            if b.get("caption"):
                beat["caption"] = b["caption"]
                if b["caption"].startswith("*"):
                    beat["capStyle"] = "fx"

        beat["t0"] = int(t * 1000)
        beat["t1"] = int((t + beat_dur) * 1000)

        act = beat["action"]
        if act in AUTO_SFX and not b.get("no_sfx"):
            for name, frac in AUTO_SFX[act]:
                sfx_events.append((t + frac * beat_dur, name))
        if b.get("sfx"):
            names = b["sfx"] if isinstance(b["sfx"], list) else [b["sfx"]]
            for name in names:
                sfx_events.append((t + 0.05, name))
        if beat.get("punch"):
            sfx_events.append((t, "ding"))
        if beat.get("ring"):
            sfx_events.append((t + 0.05, "alarm"))

        beats_out.append(beat)
        t += beat_dur

    total = t + config.TAIL_HOLD
    timeline = {"beats": beats_out, "total": int(total * 1000)}
    return timeline, voice_events, sfx_events, total
