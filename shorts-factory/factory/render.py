"""Frame-by-frame capture of the stage with Playwright, then ffmpeg encode."""
import json
import math
import os
import shutil
import subprocess
import tempfile

from . import config


def _ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _chrome():
    for c in config.CHROME_CANDIDATES:
        if os.path.exists(c):
            return c
    return None  # let playwright use its own download


def render(timeline, audio_wav, out_mp4, stage="dino"):
    from playwright.sync_api import sync_playwright

    stage_html = config.STAGES.get(stage, config.STAGE_HTML)
    total_ms = timeline["total"]
    n_frames = math.ceil(total_ms / 1000 * config.FPS)
    frames_dir = tempfile.mkdtemp(prefix="frames_")

    try:
        with sync_playwright() as p:
            kwargs = {}
            exe = _chrome()
            if exe:
                kwargs["executable_path"] = exe
            browser = p.chromium.launch(**kwargs)
            page = browser.new_page(
                viewport={"width": config.WIDTH, "height": config.HEIGHT},
                device_scale_factor=1,
            )
            page.goto("file://" + stage_html)
            page.evaluate("document.fonts.ready.then(()=>1)")
            page.wait_for_function("document.fonts.status === 'loaded'")
            page.evaluate(f"__load({json.dumps(timeline)})")
            for i in range(n_frames):
                t = i / config.FPS * 1000
                page.evaluate(f"__seek({t})")
                page.screenshot(
                    path=os.path.join(frames_dir, f"f{i:05d}.jpg"),
                    type="jpeg",
                    quality=88,
                )
                if i % 120 == 0:
                    print(f"[render] frame {i}/{n_frames}", flush=True)
            browser.close()

        print("[render] encoding ...", flush=True)
        cmd = [
            _ffmpeg(), "-y",
            "-framerate", str(config.FPS),
            "-i", os.path.join(frames_dir, "f%05d.jpg"),
            "-i", audio_wav,
            "-c:v", "libx264", "-preset", "medium", "-crf", "19",
            "-pix_fmt", "yuv420p",
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest",
            out_mp4,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)
    return out_mp4
