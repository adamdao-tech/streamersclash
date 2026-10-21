"""VOD access: stream URLs via yt-dlp, frames via ffmpeg (no full download)."""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from typing import Iterator

import cv2
import numpy as np
import yt_dlp

log = logging.getLogger(__name__)

SCAN_W, SCAN_H = 320, 180  # scanning resolution; 16:9 like Twitch/Kick streams


@dataclass
class Streams:
    scan_url: str  # lowest quality, for scanning the whole VOD
    hires_url: str  # best quality up to 1080p, for reading single frames
    duration: float | None
    title: str | None


def resolve(url: str) -> Streams:
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    formats = [f for f in info.get("formats", []) if f.get("vcodec") not in (None, "none") and f.get("url")]
    if not formats:
        raise RuntimeError("No video formats found (sub-only or deleted VOD?)")
    by_height = sorted(formats, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0))
    scan = next((f for f in by_height if (f.get("height") or 0) >= 150), by_height[0])
    hires_candidates = [f for f in by_height if (f.get("height") or 0) <= 1080]
    hires = hires_candidates[-1] if hires_candidates else by_height[-1]
    log.info("Streams: scan %sp, read %sp", scan.get("height"), hires.get("height"))
    return Streams(scan["url"], hires["url"], info.get("duration"), info.get("title"))


def iter_frames(stream_url: str, every_s: float, start_s: float = 0, end_s: float | None = None) -> Iterator[tuple[float, np.ndarray]]:
    """Yields (timestamp, frame) every `every_s` seconds, decoded at SCAN_W×SCAN_H."""
    cmd = ["ffmpeg", "-loglevel", "error", "-nostdin"]
    if start_s:
        cmd += ["-ss", str(start_s)]
    cmd += ["-i", stream_url]
    if end_s:
        cmd += ["-t", str(end_s - start_s)]
    cmd += ["-vf", f"fps=1/{every_s},scale={SCAN_W}:{SCAN_H}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    frame_bytes = SCAN_W * SCAN_H * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 4)
    i = 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield start_s + i * every_s, np.frombuffer(buf, np.uint8).reshape(SCAN_H, SCAN_W, 3)
            i += 1
    finally:
        proc.kill()
        err = proc.stderr.read().decode(errors="replace").strip()
        proc.wait()
        if err and i == 0:
            raise RuntimeError(f"ffmpeg: {err[-500:]}")


def grab_frame(stream_url: str, ts: float) -> np.ndarray:
    """One full-resolution frame at `ts` seconds."""
    cmd = [
        "ffmpeg", "-loglevel", "error", "-nostdin", "-ss", f"{max(ts, 0):.2f}", "-i", stream_url,
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ]
    out = subprocess.run(cmd, capture_output=True, timeout=120)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"ffmpeg grab at {ts}s failed: {out.stderr.decode(errors='replace')[-300:]}")
    frame = cv2.imdecode(np.frombuffer(out.stdout, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("Could not decode frame")
    return frame
