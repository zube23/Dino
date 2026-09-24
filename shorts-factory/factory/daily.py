"""Daily automation entry point: build the next queued sketch and publish it.

    python -m factory.daily                # build + upload next in queue
    python -m factory.daily --no-upload    # just render (dry run)
    python -m factory.daily --script 003-wifi-ritual
"""
import argparse
import datetime
import glob
import json
import os

from . import build, config


def load_state():
    if os.path.exists(config.STATE_FILE):
        with open(config.STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"published": []}


def save_state(state):
    with open(config.STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def next_script(state):
    done = {p["id"] for p in state["published"]}
    for path in sorted(glob.glob(os.path.join(config.QUEUE_DIR, "*.json"))):
        sid = os.path.splitext(os.path.basename(path))[0]
        if sid not in done:
            return sid
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", help="build this script id instead of the next queued one")
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--privacy", default="public", choices=["public", "unlisted", "private"])
    args = ap.parse_args()

    state = load_state()
    sid = args.script or next_script(state)
    if not sid:
        print("[daily] queue is empty — add new scripts to queue/scripts/. Nothing to do.")
        return

    mp4, meta = build.build_video(sid)

    if args.no_upload:
        print(f"[daily] dry run, not uploading. Video at {mp4}")
        return

    from . import upload
    vid = upload.upload(mp4, meta, privacy=args.privacy)

    if not args.script:  # only advance the queue for scheduled runs
        state["published"].append({
            "id": sid,
            "videoId": vid,
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        })
        save_state(state)
        print(f"[daily] state updated ({len(state['published'])} published)")


if __name__ == "__main__":
    main()
