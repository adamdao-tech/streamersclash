"""Scan a VOD: find champion selects and post-game screens, read the final draft
of each game and, when the game was played out, its result and scoreboard."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import video
from .champions import ChampionDB
from .detect import Finder, is_screen
from .layout import SCREENS
from .ocr import DraftReading, read_draft
from .postgame import match_to_draft, read_postgame

log = logging.getLogger(__name__)

MAX_GAME_S = 90 * 60  # a post-game screen later than this after the draft belongs to something else


@dataclass
class Episode:
    screen: str
    start: float
    end: float  # last timestamp where the screen was seen
    hits: int


@dataclass
class DraftResult:
    episode: Episode
    ts: float
    reading: DraftReading
    client_jpeg: bytes
    width: int
    height: int
    postgame: dict | None = None
    postgame_ts: float | None = None
    postgame_jpeg: bytes | None = None


@dataclass
class ScanResult:
    drafts: list[Episode] = field(default_factory=list)
    postgames: list[Episode] = field(default_factory=list)


def fmt(ts: float) -> str:
    ts = int(ts)
    return f"{ts // 3600}:{ts % 3600 // 60:02d}:{ts % 60:02d}"


def find_episodes(streams: video.Streams, every_s: float = 5, start_s: float = 0, end_s: float | None = None) -> ScanResult:
    finders = {name: Finder(name, work_width=video.SCAN_W, full_search_every=6) for name in SCREENS}
    episodes: dict[str, list[Episode]] = {name: [] for name in SCREENS}
    current: dict[str, Episode | None] = {name: None for name in SCREENS}
    last_log = time.monotonic()

    for ts, frame in video.iter_frames(streams.scan_url, every_s, start_s, end_s):
        for name, finder in finders.items():
            if finder.find(frame).score < finder.threshold:
                continue
            # Both screens are the same client window: share where it is.
            for other in finders.values():
                if other.hint is None:
                    other.hint = finder.hint
            ep = current[name]
            if ep and ts - ep.end <= every_s * 3:
                ep.end, ep.hits = ts, ep.hits + 1
            else:
                current[name] = Episode(name, ts, ts, 1)
                episodes[name].append(current[name])
            break  # one screen per frame
        if time.monotonic() - last_log > 30:
            n = sum(1 for e in episodes["champselect"] if e.hits >= SCREENS["champselect"]["min_hits"])
            log.info("  scanned to %s, champ selects so far: %d", fmt(ts), n)
            last_log = time.monotonic()

    keep = {name: [e for e in eps if e.hits >= SCREENS[name]["min_hits"]] for name, eps in episodes.items()}
    return ScanResult(keep["champselect"], keep["postgame"])


def postgame_for(draft: Episode, scan: ScanResult) -> Episode | None:
    """The first post-game screen after this draft and before the next one."""
    next_draft = min((d.start for d in scan.drafts if d.start > draft.end), default=float("inf"))
    for p in scan.postgames:
        if draft.end < p.start < next_draft and p.start - draft.end <= MAX_GAME_S:
            return p
    return None


def _jpeg(img: np.ndarray, width: int = 1280) -> tuple[bytes, int, int]:
    h = round(img.shape[0] * width / img.shape[1])
    out = cv2.resize(img, (width, h), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return jpg.tobytes(), width, h


def read_at(streams: video.Streams, ts: float, db: ChampionDB, debug_dir: Path | None = None) -> tuple[DraftReading, np.ndarray] | None:
    frame = video.grab_frame(streams.hires_url, ts)
    ok, rect = is_screen(frame, "champselect")
    if not ok:
        log.debug("no champ select at %s (score %.2f)", fmt(ts), rect.score)
        return None
    crop = rect.crop(frame)
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "frame.jpg"), frame)
    return read_draft(crop, db, debug_dir), crop


def read_postgame_at(streams: video.Streams, ts: float, ally: list[str], enemy: list[str], debug_dir: Path | None = None):
    frame = video.grab_frame(streams.hires_url, ts)
    ok, rect = is_screen(frame, "postgame")
    if not ok:
        return None
    crop = rect.crop(frame)
    pg = read_postgame(crop, debug_dir)
    return match_to_draft(pg, ally, enemy), crop


def read_episode(streams: video.Streams, ep: Episode, db: ChampionDB, scan: ScanResult | None = None, debug_root: Path | None = None) -> DraftResult | None:
    """Reads the finished draft (a few moments before champ select ended), then the game's post-game screen."""
    debug_dir = debug_root / f"draft_{int(ep.end)}" if debug_root else None
    best: tuple[float, DraftReading, np.ndarray] | None = None
    for back in (1, 4, 8, 13):
        ts = max(ep.end - back, ep.start)
        got = read_at(streams, ts, db, debug_dir)
        if not got:
            continue
        reading, crop = got
        if not best or (reading.picks_found, reading.confidence) > (best[1].picks_found, best[1].confidence):
            best = (ts, reading, crop)
        if reading.picks_confident:
            break
    if not best:
        return None
    ts, reading, crop = best
    jpg, w, h = _jpeg(crop)
    res = DraftResult(ep, ts, reading, jpg, w, h)

    pg_ep = postgame_for(ep, scan) if scan else None
    ally = [s.champion for s in reading.ally if s.champion]
    enemy = [s.champion for s in reading.enemy if s.champion]
    if pg_ep and len(ally) == 5 and len(enemy) == 5:
        # The scoreboard animates in; read a few seconds after it appears, keep the best fit.
        for offset in (4, 12, 25):
            t = min(pg_ep.start + offset, pg_ep.end)
            got = read_postgame_at(streams, t, ally, enemy, debug_dir)
            if got and got[0] and (res.postgame is None or got[0]["fit"] > res.postgame["fit"]):
                res.postgame, res.postgame_ts = got[0], t
                res.postgame_jpeg = _jpeg(got[1])[0]
            if res.postgame and res.postgame["fit"] >= 70:
                break
    return res
