"""One-time YouTube authorization via Google's device flow.

Run:  python -m factory.get_token CLIENT_ID CLIENT_SECRET
It prints a URL and a short code. Open the URL (any device), enter the code,
approve — and this script prints the JSON blob to store as the YT_OAUTH_JSON
GitHub secret. Nothing else ever needs to be done by hand again.

The OAuth client must be of type "TVs and Limited Input devices".
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

SCOPE = "https://www.googleapis.com/auth/youtube.upload"
DEVICE_URL = "https://oauth2.googleapis.com/device/code"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def _post(url, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)


def main(client_id, client_secret):
    d = _post(DEVICE_URL, {"client_id": client_id, "scope": SCOPE})
    if "device_code" not in d:
        raise SystemExit(f"Device flow failed: {d}")
    print()
    print("=== OPEN THIS URL AND ENTER THE CODE ===")
    print(f"  URL : {d.get('verification_url', d.get('verification_uri'))}")
    print(f"  CODE: {d['user_code']}")
    print("========================================")
    print("Waiting for approval", end="", flush=True)

    interval = d.get("interval", 5)
    deadline = time.time() + d.get("expires_in", 1800)
    while time.time() < deadline:
        time.sleep(interval)
        t = _post(TOKEN_URL, {
            "client_id": client_id,
            "client_secret": client_secret,
            "device_code": d["device_code"],
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        })
        if "refresh_token" in t:
            blob = {
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": t["refresh_token"],
            }
            out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
            os.makedirs(out_dir, exist_ok=True)
            path = os.path.join(out_dir, "yt_oauth.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(blob, f)
            print("\n\nSUCCESS. Store this JSON as the GitHub secret YT_OAUTH_JSON:")
            print(json.dumps(blob))
            print(f"(also saved to {path} — do not commit that file)")
            return
        err = t.get("error")
        if err == "authorization_pending":
            print(".", end="", flush=True)
            continue
        if err == "slow_down":
            interval += 3
            continue
        raise SystemExit(f"\nAuthorization failed: {t}")
    raise SystemExit("\nTimed out — run the script again.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python -m factory.get_token CLIENT_ID CLIENT_SECRET")
    main(sys.argv[1], sys.argv[2])
