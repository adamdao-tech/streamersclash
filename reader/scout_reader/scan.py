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
from .postgame import kda_rows, match_open, match_to_draft, read_postgame

log = logging.getLogger(__name__)

MAX_GAME_S = 90 * 60  # a post-game screen later than this after the draft belongs to something else


@dataclass
class Episode:
    screen: str
    start: float
    end: float  # last timestamp where the screen was seen
    hits: int
    best_score: float = 0.0
    best_ts: float = 0.0
    rect: tuple[float, float, float, float] | None = None  # client at best_ts, as a fraction of the frame (x, y, w, h)
    top: list = field(default_factory=list)  # best few (score, ts, rect) – weak matches are confirmed from these


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
    postgame_ep: Episode | None = None  # the post-game screen this draft used (others stay free for the post-game-only pass)


@dataclass
class ScanResult:
    drafts: list[Episode] = field(default_factory=list)
    postgames: list[Episode] = field(default_factory=list)


def fmt(ts: float) -> str:
    ts = int(ts)
    return f"{ts // 3600}:{ts % 3600 // 60:02d}:{ts % 60:02d}"


def min_hits(screen: str, every_s: float) -> int:
    """Sampled frames a screen must be seen in to count, from how long it must be on screen."""
    return max(1, round(SCREENS[screen].get("min_seconds", 0) / every_s))


def find_episodes(streams: video.Streams, every_s: float = 5, start_s: float = 0, end_s: float | None = None) -> ScanResult:
    finders = {name: Finder(name, work_width=video.SCAN_W, full_search_every=6) for name in SCREENS}
    episodes: dict[str, list[Episode]] = {name: [] for name in SCREENS}
    current: dict[str, Episode | None] = {name: None for name in SCREENS}
    last_log = time.monotonic()

    for ts, frame in video.iter_frames(streams.scan_url, every_s, start_s, end_s):
        fh, fw = frame.shape[:2]
        for name, finder in finders.items():
            r = finder.find(frame)
            cand = SCREENS[name].get("candidate_threshold")
            weak_ok = cand is not None and r.score >= cand and r.w >= SCREENS[name]["candidate_min_frac"] * fw
            if r.score < finder.threshold and not weak_ok:
                continue
            # Both screens are the same client window: share where it is.
            for other in finders.values():
                if other.hint is None:
                    other.hint = finder.hint
            ep = current[name]
            if ep and ts - ep.end <= SCREENS[name].get("merge_gap_s", every_s * 3):
                ep.end, ep.hits = ts, ep.hits + 1
            else:
                ep = current[name] = Episode(name, ts, ts, 1)
                episodes[name].append(ep)
            rect = (r.x / fw, r.y / fh, r.w / fw, r.h / fh)
            if r.score > ep.best_score:
                ep.best_score, ep.best_ts, ep.rect = r.score, ts, rect
            ep.top = sorted(ep.top + [(r.score, ts, rect)], key=lambda t: -t[0])[:3]
            break  # one screen per frame
        if time.monotonic() - last_log > 30:
            n = sum(1 for e in episodes["champselect"] if e.hits >= min_hits("champselect", every_s))
            log.info("  scanned to %s, champ selects so far: %d", fmt(ts), n)
            last_log = time.monotonic()

    keep = {name: [e for e in eps if e.hits >= min_hits(name, every_s)] for name, eps in episodes.items()}
    # weak post-game matches: keep only those whose scoreboard really reads (VICTORY/DEFEAT, K/D/A rows)
    postgames = [e for e in keep["postgame"] if e.best_score >= SCREENS["postgame"]["threshold"] or _confirm_postgame(streams, e)]
    return ScanResult(keep["champselect"], postgames)


def _client_crop(frame: np.ndarray, rect: tuple[float, float, float, float]) -> np.ndarray:
    h, w = frame.shape[:2]
    x, y, rw, rh = rect
    return frame[max(int(y * h), 0) : int((y + rh) * h), max(int(x * w), 0) : int((x + rw) * w)]


def _confirm_postgame(streams: video.Streams, ep: Episode) -> bool:
    """Reads the scoreboard at the episode's best few frames; the first that reads becomes the episode's best."""
    for score, ts, rect in ep.top or [(ep.best_score, ep.best_ts, ep.rect)]:
        try:
            frame = video.grab_frame(streams.hires_url, ts)
        except Exception as e:  # noqa: BLE001
            log.debug("post-game check at %s failed: %s", fmt(ts), e)
            continue
        # The scan's 320 px rectangle is a few pixels off at 1080p: nudge it to where the K/D/A column reads best.
        rows, rect = max(((kda_rows(_client_crop(frame, r)), r) for r in _nudges(rect)), key=lambda t: t[0])
        # Six or more rows of "K / D / A" at the scoreboard's positions don't happen by chance.
        ok = rows >= 6
        log.info("  %s: possible post-game screen (score %.2f) – %s", fmt(ts), score,
                 f"confirmed ({rows} K/D/A rows)" if ok else f"not a scoreboard ({rows} K/D/A rows)")
        if ok:
            ep.best_score, ep.best_ts, ep.rect = score, ts, rect
            return True
    return False


def _nudges(rect: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    x, y, w, h = rect
    out = []
    for s in (1.0, 0.985, 1.015):
        for dx in (0.0, -0.004, 0.004):
            for dy in (0.0, -0.006, 0.006):
                nw, nh = w * s, h * s
                out.append((x + (w - nw) / 2 + dx, y + (h - nh) / 2 + dy, nw, nh))
    return out


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
    ok, rect = is_screen(frame, "postgame", leniency=0.05)
    if not ok:
        return None
    crop = rect.crop(frame)
    pg = read_postgame(crop, debug_dir)
    return match_to_draft(pg, ally, enemy), crop


def read_postgame_open_at(streams: video.Streams, ts: float, names: list[str], ally: list[str] | None, debug_dir: Path | None = None,
                          hint: tuple[float, float, float, float] | None = None):
    frame = video.grab_frame(streams.hires_url, ts)
    ok, rect = is_screen(frame, "postgame", leniency=0.05)
    if ok:
        crop = rect.crop(frame)
    elif hint:  # a confirmed weak match: the client is where the scan saw it
        crop = _client_crop(frame, hint)
    else:
        return None
    return match_open(read_postgame(crop, debug_dir), names, ally), crop


def _open_quality(pg: dict) -> float:
    """How complete an open scoreboard read is: champion fit plus K/D/A rows and the result (a frame where the
    table is still animating in, or a tooltip covers it, can fit the champions well and read little else)."""
    rows = pg["ally"] + pg["enemy"]
    kda = sum(1 for r in rows if r.get("kills") is not None)
    return pg["fit"] + 4 * kda + (10 if pg.get("result") else 0) + (5 if pg.get("duration_s") else 0)


def best_open_postgame(streams: video.Streams, pg_ep: Episode, db: ChampionDB, ally: list[str] | None, debug_dir: Path | None = None):
    """Reads a post-game screen without a full draft (blind pick / drafted outside the client): best of a few moments.
    The confirmed frame (where the K/D/A column read) goes first; reading stops once a frame reads completely."""
    names = [c.name for c in db.champions]
    best = None
    later = sorted({min(pg_ep.start + o, pg_ep.end) for o in (4, 12, 25)} | {min(pg_ep.best_ts + 6, pg_ep.end)})
    moments = [pg_ep.best_ts] + [t for t in later if t != pg_ep.best_ts]
    for t in moments:
        got = read_postgame_open_at(streams, t, names, ally, debug_dir, pg_ep.rect)
        if got and got[0] and (best is None or _open_quality(got[0]) > _open_quality(best[0])):
            best = (got[0], t, *_jpeg(got[1]))  # payload, ts, jpeg, width, height
        if best and best[0]["fit"] >= 85 and all(r.get("kills") is not None for r in best[0]["ally"] + best[0]["enemy"]) \
                and best[0].get("result"):
            break
    return best


def unused_postgames(scan: ScanResult, used: set[int]) -> list[Episode]:
    """Post-game screens no saved draft took (`used` = ids of the episodes drafts read their scoreboard from).

    A post-game screen counts as taken only when a draft really used it. The scan also "finds" champ selects in
    in-game frames that the full-resolution check then rejects, and real champ selects can fail to read: before,
    such a draft still claimed the next post-game screen and the whole game was lost. Now every scoreboard no
    draft used is read on its own (the app merges it into the draft's game when both got saved)."""
    return [p for p in scan.postgames if id(p) not in used]


def read_draft_episode(streams: video.Streams, ep: Episode, db: ChampionDB, debug_root: Path | None = None) -> DraftResult | None:
    """Reads the finished draft of a champ select episode (a few moments before it ended); None when the
    full-resolution check rejects it (a false find in an in-game frame) or nothing reads."""
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
    return DraftResult(ep, ts, reading, jpg, w, h)


def real_drafts(scan: ScanResult, results: list[DraftResult]) -> ScanResult:
    """The scan with only the champ selects that really read: a false find (in-game frame) must not stand between
    a draft and its post-game screen."""
    return ScanResult([r.episode for r in results], scan.postgames)


def attach_postgame(streams: video.Streams, res: DraftResult, db: ChampionDB, scan: ScanResult, debug_root: Path | None = None) -> DraftResult:
    """Reads the post-game screen of the draft's game (the first one after it and before the next real draft)."""
    debug_dir = debug_root / f"draft_{int(res.episode.end)}" if debug_root else None
    reading = res.reading
    pg_ep = postgame_for(res.episode, scan)
    ally = [s.champion for s in reading.ally if s.champion]
    enemy = [s.champion for s in reading.enemy if s.champion]
    if pg_ep and len(ally) == 5 and len(enemy) < 5:
        # Blind pick: the enemy team isn't shown in champ select – take it from the scoreboard.
        got = best_open_postgame(streams, pg_ep, db, ally, debug_dir)
        if got:
            res.postgame, res.postgame_ts, res.postgame_jpeg = got[:3]
            res.postgame_ep = pg_ep
    elif pg_ep and len(ally) == 5 and len(enemy) == 5:
        # The scoreboard animates in; read a few seconds after it appears, keep the best fit.
        for offset in (4, 12, 25):
            t = min(pg_ep.start + offset, pg_ep.end)
            got = read_postgame_at(streams, t, ally, enemy, debug_dir)
            if got and got[0] and (res.postgame is None or got[0]["fit"] > res.postgame["fit"]):
                res.postgame, res.postgame_ts = got[0], t
                res.postgame_jpeg = _jpeg(got[1])[0]
                res.postgame_ep = pg_ep
            if res.postgame and res.postgame["fit"] >= 70:
                break
    return res


def read_episode(streams: video.Streams, ep: Episode, db: ChampionDB, scan: ScanResult | None = None, debug_root: Path | None = None) -> DraftResult | None:
    """Reads the finished draft, then the game's post-game screen (`test`-style one-off use)."""
    res = read_draft_episode(streams, ep, db, debug_root)
    if res and scan:
        attach_postgame(streams, res, db, scan, debug_root)
    return res
