"""drafter.lol on stream: bans of drafts made outside the client.

Many teams draft scrims on drafter.lol and then play a blind-pick custom game, so the client never shows bans.
When the streamer has the drafter.lol page on screen, the scan finds it (layout.SCREENS["drafter"]); here the
last frame of that draft is read at full resolution:

- the ten ban icons (grey with a slash) are matched against the champion icons; an empty slot stays empty,
- the ten pick panels (champion splash art) are kept, and once the game after the draft is known, they are
  compared with the splash art of that game's ten champions. That tells which column (blue/red) was the
  streamer's team and confirms the draft belongs to that game – without it no bans are used.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import requests

from . import layout as L
from . import video
from .champions import ChampionDB
from .detect import Finder, _gradient, _match, _reference

log = logging.getLogger(__name__)

DDRAGON = "https://ddragon.leagueoflegends.com"
BAN_OK = 0.55  # icon similarity needed to accept a ban (real bans read ~0.75–0.95)
BAN_MARGIN = 0.03  # …and this much better than the second best icon
EMPTY_STD = 22  # an empty ban slot is a flat grey box (brightness spread ~12, icons 40+)
SPLASH_OK = 0.62  # a pick panel counts as a champion's splash from this similarity
SPLASH_MARGIN = 0.07
GAME_GAP_S = 20 * 60  # a draft older than this before the game's champ select / start belongs to something else


@dataclass
class DrafterBan:
    champion: str | None
    score: float
    margin: float


@dataclass
class DrafterReading:
    ts: float
    score: float  # how well the page matched
    bans: dict[str, list[DrafterBan]]  # "blue"/"red" → bans 1–5 in draft order
    panels: dict[str, list[np.ndarray]] = field(default_factory=dict)  # "blue"/"red" → 5 pick panel crops

    def ban_names(self, side: str) -> list[str]:
        return [b.champion for b in self.bans[side] if b.champion]

    def summary(self) -> str:
        def s(side):
            return ", ".join(b.champion or "–" for b in self.bans[side])
        return f"blue bans: {s('blue')} | red bans: {s('red')}"


def _page(frame: np.ndarray) -> tuple[float, float, float, float, float] | None:
    """The drafter.lol page in a full-resolution frame: (x, y, w, h, score) in pixels, or None.
    The coarse search steps the size by 2.5 % of the frame – too rough for the small ban icons – so the
    rectangle is then refined in finer steps around where it was found."""
    f = Finder("drafter", work_width=480)
    r = f.find(frame, threshold=f.threshold - 0.08)
    if r.score < f.threshold - 0.08:
        return None
    ww = min(960, frame.shape[1])
    s = ww / frame.shape[1]
    small = cv2.resize(frame, (ww, round(frame.shape[0] * s)), interpolation=cv2.INTER_AREA)
    grad = _gradient(small)
    ref_h, ref_w = _reference("drafter").shape[:2]
    best = (r.score, r.x, r.y, r.w, r.h)
    for k in np.arange(0.95, 1.0501, 0.005):
        tw = int(round(r.w * s * k))
        th = int(round(tw * ref_h / ref_w))
        pad = max(6, int(tw * 0.03))
        x0, y0 = max(int(r.x * s) - pad, 0), max(int(r.y * s) - pad, 0)
        x1, y1 = min(int(r.x * s) + int(r.w * s) + pad, grad.shape[1]), min(int(r.y * s) + int(r.h * s) + pad, grad.shape[0])
        if x1 - x0 < tw or y1 - y0 < th:
            continue
        score, loc = _match(grad[y0:y1, x0:x1], "drafter", tw, th)
        if score > best[0]:
            best = (score, (x0 + loc[0]) / s, (y0 + loc[1]) / s, tw / s, th / s)
    score, x, y, w, h = best
    return x, y, w, h, score


def _gray_icons(db: ChampionDB, size: int, cache: dict) -> dict[str, list[np.ndarray]]:
    """Champion icons in grey (drafter.lol shows bans desaturated), each zoomed in a few ways (the page crops the
    icon's border) and softened a little like a stream is."""
    key = size
    if key not in cache:
        out = {}
        for cid, icon in db.icons().items():
            g = cv2.cvtColor(icon, cv2.COLOR_BGR2GRAY)
            variants = []
            for zoom in (0.04, 0.08, 0.12):
                m = int(round(g.shape[0] * zoom))
                t = cv2.resize(g[m : g.shape[0] - m, m : g.shape[1] - m], (size, size), interpolation=cv2.INTER_AREA)
                variants.append(cv2.GaussianBlur(t, (3, 3), 0).astype(np.float32))
            out[cid] = variants
        cache[key] = out
    return cache[key]


def _read_ban(frame_gray: np.ndarray, cx: float, cy: float, bw: float, bh: float, db: ChampionDB, cache: dict) -> DrafterBan:
    size = max(16, int(round(min(bw, bh))))
    pad = int(round(size * 0.25))
    x0, y0 = int(round(cx - size / 2)) - pad, int(round(cy - size / 2)) - pad
    crop = frame_gray[max(y0, 0) : y0 + size + 2 * pad, max(x0, 0) : x0 + size + 2 * pad]
    if crop.shape[0] < size or crop.shape[1] < size:
        return DrafterBan(None, 0.0, 0.0)
    crop = crop.astype(np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    off_slash = np.abs(xx - yy) > max(2, size // 12)
    # an empty slot: the flat grey box (a faint placeholder, the slash) where the icon would be
    inner = crop[pad : pad + size, pad : pad + size]
    m = size // 8
    keep = off_slash.copy()
    keep[:m, :] = keep[-m:, :] = keep[:, :m] = keep[:, -m:] = False
    if inner.shape == keep.shape and float(inner[keep].std()) < EMPTY_STD:
        return DrafterBan(None, 0.0, 0.0)
    # the white slash across every ban is the same on all of them: leave it out of the comparison
    mask = off_slash.astype(np.float32)
    scores = []
    for cid, icons in _gray_icons(db, size, cache).items():
        best = -1.0
        for icon in icons:
            r = cv2.matchTemplate(crop, icon, cv2.TM_CCOEFF_NORMED, mask=mask)
            best = max(best, float(np.nan_to_num(r, nan=0.0, posinf=0.0, neginf=0.0).max()))
        scores.append((best, cid))
    scores.sort(reverse=True)
    (s1, best), (s2, _) = scores[0], scores[1]
    if s1 < BAN_OK or s1 - s2 < BAN_MARGIN:
        return DrafterBan(None, round(s1, 3), round(s1 - s2, 3))
    champ = db.by_id(best)
    return DrafterBan(champ.name if champ else best, round(s1, 3), round(s1 - s2, 3))


def read_frame(frame: np.ndarray, db: ChampionDB, ts: float = 0.0, cache: dict | None = None,
               debug_dir: Path | None = None) -> DrafterReading | None:
    page = _page(frame)
    if not page:
        return None
    x, y, w, h, score = page
    cache = {} if cache is None else cache
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    bw, bh = L.DRAFTER_BAN_SIZE[0] * w, L.DRAFTER_BAN_SIZE[1] * h
    cy = y + L.DRAFTER_BAN_Y * h
    bans = {side: [_read_ban(gray, x + fx * w, cy, bw, bh, db, cache) for fx in xs] for side, xs in L.DRAFTER_BAN_X.items()}
    # a champion is banned once at most: a second read of the same one is the weaker guess
    seen: dict[str, DrafterBan] = {}
    for b in bans["blue"] + bans["red"]:
        if not b.champion:
            continue
        other = seen.get(b.champion)
        if other is None:
            seen[b.champion] = b
            continue
        loser = b if b.score <= other.score else other
        seen[b.champion] = other if loser is b else b
        loser.champion = None
    panels = {}
    for side, (fx0, fx1) in L.DRAFTER_COLS.items():
        crops = []
        for k in range(5):
            py0 = int(y + (L.DRAFTER_ROWS[k] + 0.008) * h)
            py1 = int(y + (L.DRAFTER_ROWS[k + 1] - 0.006) * h)
            crops.append(frame[max(py0, 0) : py1, max(int(x + fx0 * w), 0) : int(x + fx1 * w)].copy())
        panels[side] = crops
    reading = DrafterReading(ts, round(score, 3), bans, panels)
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / f"drafter_{int(ts)}.jpg"), frame[int(y) : int(y + h), int(x) : int(x + w)])
    return reading


def read_episode(streams: video.Streams, ep, db: ChampionDB, debug_root: Path | None = None) -> DrafterReading | None:
    """The finished draft: the last moments the page was on screen (the final picks and bans are in)."""
    cache: dict = {}
    best: DrafterReading | None = None
    for back in (0, 3, 7):
        ts = max(ep.end - back, ep.start)
        try:
            frame = video.grab_frame(streams.hires_url, ts)
        except Exception as e:  # noqa: BLE001
            log.debug("drafter frame at %s failed: %s", ts, e)
            continue
        r = read_frame(frame, db, ts, cache, debug_root)
        if not r:
            continue
        n = sum(1 for side in ("blue", "red") for b in r.bans[side] if b.champion)
        if not best or n > sum(1 for side in ("blue", "red") for b in best.bans[side] if b.champion):
            best = r
        if n == 10:
            break
    return best


# --- which column is whose: pick panels vs the game's champions ---------------------------------------------


def _splash(champ_id: str, cache_dir: Path) -> np.ndarray | None:
    f = cache_dir / "splash" / f"{champ_id}_0.jpg"
    if not f.exists():
        try:
            r = requests.get(f"{DDRAGON}/cdn/img/champion/centered/{champ_id}_0.jpg", timeout=30)
        except requests.RequestException as e:
            log.debug("splash %s: %s", champ_id, e)
            return None
        if not r.ok:
            return None
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(r.content)
    img = cv2.imread(str(f))
    return cv2.resize(img, (256, 144), interpolation=cv2.INTER_AREA) if img is not None else None


def _panel_score(panel: np.ndarray, splash: np.ndarray) -> float:
    """How well a pick panel (a horizontal strip of the splash art) fits somewhere in the splash."""
    if panel.size == 0:
        return -1.0
    pw = 128
    ph = max(8, round(panel.shape[0] * pw / panel.shape[1]))
    p = cv2.resize(panel, (pw, ph), interpolation=cv2.INTER_AREA).astype(np.float32)
    best = -1.0
    for s in (1.0, 1.15, 1.3, 1.5, 1.75, 2.0):
        w = round(pw * s)
        h = round(w * splash.shape[0] / splash.shape[1])
        if h < ph:
            continue
        t = cv2.resize(splash, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
        best = max(best, float(cv2.matchTemplate(t, p, cv2.TM_CCOEFF_NORMED).max()))
    return best


def ally_side(reading: DrafterReading, ally: list[str], enemy: list[str], db: ChampionDB, cache_dir: Path) -> tuple[str | None, int]:
    """Which drafter column ("blue"/"red") holds the `ally` champions, and how many panels agreed.
    None when the panels don't clearly show this game's champions (a different draft, art not recognised)."""
    by_name = {c.name: c for c in db.champions}
    cands: dict[str, tuple[str, np.ndarray]] = {}
    for team, names in (("ally", ally), ("enemy", enemy)):
        for n in names:
            c = by_name.get(n)
            img = _splash(c.id, cache_dir) if c else None
            if img is not None:
                cands[n] = (team, img)
    if len(cands) < 6:
        return None, 0
    votes = {("blue", "ally"): 0, ("blue", "enemy"): 0, ("red", "ally"): 0, ("red", "enemy"): 0}
    for side in ("blue", "red"):
        for panel in reading.panels.get(side, []):
            sc = sorted(((_panel_score(panel, img), team) for team, img in cands.values()), reverse=True)
            if len(sc) >= 2 and sc[0][0] >= SPLASH_OK and sc[0][0] - sc[1][0] >= SPLASH_MARGIN:
                votes[(side, sc[0][1])] += 1
    blue_is_ally = votes[("blue", "ally")] + votes[("red", "enemy")]
    red_is_ally = votes[("red", "ally")] + votes[("blue", "enemy")]
    if blue_is_ally >= 6 and blue_is_ally - red_is_ally >= 4:
        return "blue", blue_is_ally
    if red_is_ally >= 6 and red_is_ally - blue_is_ally >= 4:
        return "red", red_is_ally
    return None, max(blue_is_ally, red_is_ally)


def for_game(readings: list[DrafterReading], game_start: float) -> DrafterReading | None:
    """The draft right before a game: the last drafter.lol page seen before the game started (within 20 min)."""
    before = [r for r in readings if game_start - GAME_GAP_S <= r.ts <= game_start + 30]
    return max(before, key=lambda r: r.ts) if before else None


def bans_for(readings: list[DrafterReading], game_start: float, ally: list[str], enemy: list[str], db: ChampionDB,
             cache_dir: Path) -> tuple[list[str], list[str], str] | None:
    """(ally bans, enemy bans, log line) from the drafter.lol draft before this game, or None."""
    r = for_game(readings, game_start)
    if not r or len(ally) + len(enemy) < 8:
        return None
    side, agree = ally_side(r, ally, enemy, db, cache_dir)
    if not side:
        log.info("  drafter.lol at %ds: picks don't match this game clearly (%d of 10 panels) – bans not used", int(r.ts), agree)
        return None
    other = "red" if side == "blue" else "blue"
    a, e = r.ban_names(side), r.ban_names(other)
    picked = set(ally) | set(enemy)
    if picked & (set(a) | set(e)):
        log.info("  drafter.lol at %ds: a 'ban' is picked in the game – misread, bans not used", int(r.ts))
        return None
    return a, e, f"drafter.lol at {int(r.ts)}s: streamer's team on {side} ({agree}/10 picks recognised); {r.summary()}"
