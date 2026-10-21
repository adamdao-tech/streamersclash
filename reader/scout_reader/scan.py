"""Scan a VOD: find champion select episodes and read the final draft of each."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import video
from .champions import ChampionDB
from .detect import DEFAULT_THRESHOLD, find_client
from .ocr import DraftReading, read_draft

log = logging.getLogger(__name__)


@dataclass
class Episode:
    start: float
    end: float  # last timestamp where champ select was seen
    hits: int


@dataclass
class DraftResult:
    episode: Episode
    ts: float
    reading: DraftReading
    client_jpeg: bytes
    width: int
    height: int


def fmt(ts: float) -> str:
    ts = int(ts)
    return f"{ts // 3600}:{ts % 3600 // 60:02d}:{ts % 60:02d}"


def find_episodes(
    streams: video.Streams,
    every_s: float = 5,
    threshold: float = DEFAULT_THRESHOLD,
    start_s: float = 0,
    end_s: float | None = None,
) -> list[Episode]:
    episodes: list[Episode] = []
    current: Episode | None = None
    last_log = time.monotonic()
    for ts, frame in video.iter_frames(streams.scan_url, every_s, start_s, end_s):
        if find_client(frame, work_width=video.SCAN_W).score >= threshold:
            if current and ts - current.end <= every_s * 3:
                current.end, current.hits = ts, current.hits + 1
            else:
                current = Episode(ts, ts, 1)
                episodes.append(current)
        if time.monotonic() - last_log > 30:
            log.info("  scanned to %s, champ selects so far: %d", fmt(ts), sum(1 for e in episodes if e.hits >= 3))
            last_log = time.monotonic()
    # A real champ select lasts at least ~15 s; shorter blips are false positives.
    return [e for e in episodes if e.hits >= 3]


def read_at(streams: video.Streams, ts: float, db: ChampionDB, debug_dir: Path | None = None) -> tuple[DraftReading, np.ndarray] | None:
    frame = video.grab_frame(streams.hires_url, ts)
    rect = find_client(frame, work_width=640)
    if rect.score < DEFAULT_THRESHOLD:
        log.debug("no client at %s (score %.2f)", fmt(ts), rect.score)
        return None
    crop = rect.crop(frame)
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "frame.jpg"), frame)
    return read_draft(crop, db, debug_dir), crop


def read_episode(streams: video.Streams, ep: Episode, db: ChampionDB, debug_root: Path | None = None) -> DraftResult | None:
    """Reads the finished draft: tries a few moments just before champ select ended, keeps the best."""
    best: tuple[float, DraftReading, np.ndarray] | None = None
    for back in (1, 4, 8, 13):
        ts = max(ep.end - back, ep.start)
        debug_dir = debug_root / f"draft_{int(ep.end)}" if debug_root else None
        got = read_at(streams, ts, db, debug_dir)
        if not got:
            continue
        reading, crop = got
        key = (reading.picks_found, reading.confidence)
        if not best or key > (best[1].picks_found, best[1].confidence):
            best = (ts, reading, crop)
        if reading.picks_confident:
            break
    if not best:
        return None
    ts, reading, crop = best
    out = cv2.resize(crop, (1280, 720), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return DraftResult(ep, ts, reading, jpg.tobytes(), 1280, 720)
