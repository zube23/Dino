"""Build one sketch into a finished Short: animation + voice + captions + music."""
import json
import os
import tempfile

from . import audio, config, render, timeline


def load_script(script_id):
    path = os.path.join(config.QUEUE_DIR, f"{script_id}.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_video(script_id):
    script = load_script(script_id)
    os.makedirs(config.OUT_DIR, exist_ok=True)

    tl, voice_events, sfx_events, total = timeline.build(script)
    print(f"[build] {script_id}: {len(tl['beats'])} beats, {total:.1f}s", flush=True)

    wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    audio.mix(total, voice_events, sfx_events, script_id, wav,
              style=script.get("music", "lofi"))

    out_mp4 = os.path.join(config.OUT_DIR, f"{script_id}.mp4")
    render.render(tl, wav, out_mp4, stage=script.get("stage", "dino"))
    os.unlink(wav)

    meta = {
        "title": script["title"],
        "description": build_description(script),
        "tags": script.get("tags", []),
    }
    meta_path = os.path.join(config.OUT_DIR, f"{script_id}.meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f"[build] done: {out_mp4}", flush=True)
    return out_mp4, meta_path


def build_description(script):
    lines = [script.get("description", "")]
    lines.append("")
    lines.append(" ".join(config.CHANNEL_HASHTAGS))
    lines.append("")
    lines.append(config.ATTRIBUTION)
    return "\n".join(lines).strip()


if __name__ == "__main__":
    import sys
    build_video(sys.argv[1])
