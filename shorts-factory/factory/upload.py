"""Upload a finished Short to YouTube via the official Data API v3.

Credentials come from the YT_OAUTH_JSON environment variable (or a file):
    {"client_id": "...", "client_secret": "...", "refresh_token": "..."}
Produced once by factory/get_token.py — see SETUP.md.
"""
import argparse
import json
import os
import time

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_URI = "https://oauth2.googleapis.com/token"


def load_credentials(auth_file=None):
    raw = None
    if auth_file:
        with open(auth_file, encoding="utf-8") as f:
            raw = f.read()
    else:
        raw = os.environ.get("YT_OAUTH_JSON")
    if not raw:
        raise SystemExit(
            "No credentials. Set the YT_OAUTH_JSON environment variable "
            "(GitHub secret) or pass --auth path/to/yt_oauth.json — see SETUP.md."
        )
    data = json.loads(raw)
    from google.oauth2.credentials import Credentials
    return Credentials(
        None,
        refresh_token=data["refresh_token"],
        token_uri=TOKEN_URI,
        client_id=data["client_id"],
        client_secret=data["client_secret"],
        scopes=SCOPES,
    )


def upload(mp4_path, meta_path, privacy="public", auth_file=None):
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload

    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)

    creds = load_credentials(auth_file)
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

    body = {
        "snippet": {
            "title": meta["title"][:100],
            "description": meta["description"][:4900],
            "tags": meta.get("tags", [])[:30],
            "categoryId": "23",  # Comedy
            "defaultLanguage": "en",
            "defaultAudioLanguage": "en",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }
    media = MediaFileUpload(mp4_path, chunksize=8 * 1024 * 1024, resumable=True, mimetype="video/mp4")
    request = yt.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    errors = 0
    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                print(f"[upload] {int(status.progress() * 100)}%", flush=True)
        except Exception as e:  # noqa: BLE001 - retry transient API/network errors
            errors += 1
            if errors > 5:
                raise
            wait = 2 ** errors
            print(f"[upload] retrying in {wait}s: {e}", flush=True)
            time.sleep(wait)

    vid = response["id"]
    print(f"[upload] done: https://www.youtube.com/shorts/{vid}", flush=True)
    return vid


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mp4")
    ap.add_argument("meta")
    ap.add_argument("--privacy", default="public", choices=["public", "unlisted", "private"])
    ap.add_argument("--auth")
    args = ap.parse_args()
    upload(args.mp4, args.meta, args.privacy, args.auth)
