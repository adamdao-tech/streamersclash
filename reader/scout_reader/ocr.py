"""Read a finished draft from a champion select client crop.

Champion names are printed as text in both team columns, so they're read with
Tesseract and fuzzy-matched to the champion list. Ban icons are matched against
Data Dragon's square icons. Every value gets a confidence score so the caller
can decide between saving automatically and sending the frame for review.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from rapidfuzz import fuzz

from . import layout as L
from .champions import ChampionDB, letters

log = logging.getLogger(__name__)

ROLE_WORDS = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MID": "MID", "BOTTOM": "ADC", "SUPPORT": "SUPPORT"}

# Fuzzy score (0–100) needed to accept a champion name / ban icon automatically.
PICK_OK = 90
BAN_OK = 0.80


@dataclass
class Slot:
    champion: str | None
    score: float  # 0–100
    raw: str  # OCR text of the champion line
    player_name: str | None = None
    role: str | None = None


@dataclass
class Ban:
    champion: str | None
    score: float  # 0–1 icon similarity
    margin: float  # gap to the second best icon


@dataclass
class DraftReading:
    ally: list[Slot] = field(default_factory=list)
    enemy: list[Slot] = field(default_factory=list)
    ally_bans: list[Ban] = field(default_factory=list)
    enemy_bans: list[Ban] = field(default_factory=list)

    @property
    def picks_found(self) -> int:
        return sum(1 for s in self.ally + self.enemy if s.champion)

    @property
    def picks_confident(self) -> bool:
        slots = self.ally + self.enemy
        return len(slots) == 10 and all(s.champion and s.score >= PICK_OK for s in slots)

    @property
    def bans_confident(self) -> bool:
        return all(b.champion and b.score >= BAN_OK for b in self.ally_bans + self.enemy_bans)

    @property
    def confidence(self) -> float:
        """0–1: the weakest pick, scaled; bans lower it slightly when unsure."""
        slots = self.ally + self.enemy
        if len(slots) < 10:
            return 0.0
        pick = min((s.score if s.champion else 0) for s in slots) / 100
        return round(pick * (1.0 if self.bans_confident else 0.95), 3)

    def to_payload(self, include_unsure_bans: bool = False) -> dict:
        """Shape expected by the app (DraftInput in src/drafts.ts)."""

        def bans(lst: list[Ban]) -> list[str]:
            return [b.champion for b in lst if b.champion and (include_unsure_bans or b.score >= BAN_OK)]

        return {
            "ally": [{"champion": s.champion or "?", "player_name": s.player_name, "role": s.role} for s in self.ally],
            "enemy": [{"champion": s.champion or "?"} for s in self.enemy],
            "ally_bans": bans(self.ally_bans),
            "enemy_bans": bans(self.enemy_bans),
            "ocr": {
                "ally": [asdict(s) for s in self.ally],
                "enemy": [asdict(s) for s in self.enemy],
                "ally_bans": [asdict(b) for b in self.ally_bans],
                "enemy_bans": [asdict(b) for b in self.enemy_bans],
            },
        }


def _prep_text(img: np.ndarray, scale: float) -> np.ndarray:
    """Light text on a dark background → black text on white, enlarged for Tesseract."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    _, t = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.copyMakeBorder(255 - t, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)


def _ocr_lines_psm(img: np.ndarray, psm: int) -> list[str]:
    text = pytesseract.image_to_string(img, config=f"--psm {psm} --oem 1")
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def _ocr_lines(img: np.ndarray) -> list[str]:
    text = pytesseract.image_to_string(img, config="--psm 6 --oem 1")
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def match_champion(text: str, db: ChampionDB) -> tuple[str | None, float]:
    key = letters(text)
    if len(key) < 2:
        return None, 0.0
    best, best_score = None, 0.0
    for c in db.champions:
        score = fuzz.ratio(key, c.key)
        # Lines often carry noise around the name ("> TRISTANA :"), so also try partial matches
        # for names long enough not to match by accident.
        if len(c.key) >= 4 and len(key) > len(c.key):
            score = max(score, fuzz.partial_ratio(c.key, key) - 8)
        if score > best_score:
            best, best_score = c.name, score
    return best, best_score


def _bright_text(img: np.ndarray, floor: int, target_h: int = 110) -> np.ndarray:
    """Keeps only bright text (champion names are white/gold, roles and player names are dimmer)."""
    v = img.max(axis=2)
    scale = target_h / max(img.shape[0], 1)
    v = cv2.resize(v, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    v = cv2.GaussianBlur(v, (3, 3), 0)
    otsu, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, t = cv2.threshold(v, max(otsu, floor), 255, cv2.THRESH_BINARY)
    return cv2.copyMakeBorder(255 - t, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)


def _read_slot(client: np.ndarray, x_range: tuple[float, float], y: float, db: ChampionDB, ally: bool, debug: Path | None, tag: str) -> Slot:
    h, w = client.shape[:2]

    # 1) Champion name: one bright line, read with a few vertical offsets and keep the best match.
    best = Slot(None, 0.0, "")
    attempts = [(dy, floor) for dy in (0.0, -0.006, 0.006) for floor in (115, 150, 0)]
    for dy, floor in attempts:
        x0, y0, x1, y1 = L.px((x_range[0], y + dy - L.NAME_HALF_H, x_range[1], y + dy + L.NAME_HALF_H), w, h)
        prepped = _bright_text(client[y0:y1, x0:x1], floor)
        raw = " ".join(_ocr_lines_psm(prepped, 7))
        name, score = match_champion(raw, db)
        if score > best.score:
            best = Slot(name if score >= 60 else None, round(score, 1), raw)
            if debug:
                cv2.imwrite(str(debug / f"{tag}.png"), prepped)
        if score >= 95:
            break

    # 2) Role (above) and player name (below) for our team, from the whole text block.
    if ally:
        x0, y0, x1, y1 = L.px((x_range[0], y - L.ROW_TEXT_UP, x_range[1], y + L.ROW_TEXT_DOWN), w, h)
        crop = client[y0:y1, x0:x1]
        lines = _ocr_lines(_prep_text(crop, max(1.0, 110 / max(crop.shape[0], 1))))
        champ_i = max(range(len(lines)), key=lambda i: match_champion(lines[i], db)[1], default=-1)
        if champ_i > 0:
            role_key = letters(lines[champ_i - 1])
            best.role = next((v for k, v in ROLE_WORDS.items() if fuzz.ratio(k, role_key) >= 75), None)
        if 0 <= champ_i < len(lines) - 1:
            name = lines[champ_i + 1].strip(" |:;.,'\"‘’=")
            best.player_name = name if len(name) >= 2 else None
    return best


def _read_ban(client: np.ndarray, cx: float, db: ChampionDB) -> Ban:
    icons = db.icons()
    if not icons:
        return Ban(None, 0.0, 0.0)
    h, w = client.shape[:2]
    bw, bh = L.BAN_SIZE
    x0, y0, x1, y1 = L.px((cx - bw / 2, L.BAN_Y - bh / 2, cx + bw / 2, L.BAN_Y + bh / 2), w, h)
    crop = client[y0:y1, x0:x1]
    if crop.size == 0:
        return Ban(None, 0.0, 0.0)
    size = 32
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    # An empty ban slot is nearly uniform; don't match it against icons.
    if crop.std() < 12:
        return Ban(None, 1.0, 1.0)
    scores = []
    for champ_id, icon in icons.items():
        # The client draws icons slightly zoomed; compare against a central crop of the square icon.
        m = int(icon.shape[0] * 0.08)
        ic = cv2.resize(icon[m:-m, m:-m], (size, size), interpolation=cv2.INTER_AREA)
        s = cv2.matchTemplate(crop, ic, cv2.TM_CCOEFF_NORMED)[0, 0]
        scores.append((float(s), champ_id))
    scores.sort(reverse=True)
    (s1, best), (s2, _) = scores[0], scores[1]
    champ = db.by_id(best)
    return Ban(champ.name if champ else best, round(s1, 3), round(s1 - s2, 3))


def read_draft(client_crop: np.ndarray, db: ChampionDB, debug_dir: Path | None = None) -> DraftReading:
    """Reads picks (and bans) from a crop of the client window."""
    client = cv2.resize(client_crop, (L.CANON_W, L.CANON_H), interpolation=cv2.INTER_CUBIC)
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "client.png"), client)
    r = DraftReading()
    for i, y in enumerate(L.ALLY_ROW_Y):
        r.ally.append(_read_slot(client, L.ALLY_TEXT_X, y, db, True, debug_dir, f"ally{i + 1}"))
    for i, y in enumerate(L.ENEMY_ROW_Y):
        r.enemy.append(_read_slot(client, L.ENEMY_TEXT_X, y, db, False, debug_dir, f"enemy{i + 1}"))
    r.ally_bans = [_read_ban(client, x, db) for x in L.ALLY_BAN_X]
    r.enemy_bans = [_read_ban(client, x, db) for x in L.ENEMY_BAN_X]
    _drop_duplicates(r)
    return r


def _drop_duplicates(r: DraftReading) -> None:
    """A champion can be picked only once per game: keep the more confident read, blank the other."""
    seen: dict[str, Slot] = {}
    for slot in r.ally + r.enemy:
        if not slot.champion:
            continue
        other = seen.get(slot.champion)
        if other is None:
            seen[slot.champion] = slot
            continue
        loser = slot if slot.score <= other.score else other
        loser.champion, loser.score = None, 0.0
        if loser is other:
            seen[slot.champion] = slot
