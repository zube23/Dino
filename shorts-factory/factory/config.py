import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STAGES = {
    "dino": os.path.join(ROOT, "renderer", "stage.html"),
    "war": os.path.join(ROOT, "renderer", "war.html"),
    "parkour": os.path.join(ROOT, "renderer", "parkour.html"),
}
STAGE_HTML = STAGES["dino"]  # default
QUEUE_DIR = os.path.join(ROOT, "queue", "scripts")
STATE_FILE = os.path.join(ROOT, "queue", "state.json")
OUT_DIR = os.path.join(ROOT, "out")
VOICE_DIR = os.path.join(ROOT, "assets", "voice")

VOICE_ONNX = os.path.join(VOICE_DIR, "en-us-libritts-high.onnx")
VOICE_URL = "https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-libritts-high.tar.gz"
SPEAKER_ID = 451          # deep, steady, deadpan narrator
LENGTH_SCALE = 1.06       # slightly slower = drier delivery

FPS = 30
WIDTH, HEIGHT = 1080, 1920
SAMPLE_RATE = 44100

# gaps (seconds)
DEFAULT_PAUSE_AFTER_SAY = 0.38
DEFAULT_BEAT_DUR = 1.2
TAIL_HOLD = 0.6
TALK_LEAD = 0.08

CHROME_CANDIDATES = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
]

CHANNEL_HASHTAGS = ["#shorts", "#animation", "#lawnwar"]
ATTRIBUTION = "Voice: Piper TTS, LibriTTS voice model (CC BY 4.0, openslr.org/60)."
