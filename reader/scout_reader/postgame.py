"""Read the post-game scoreboard: result, game type, duration, and for all ten
players their name, champion and K/D/A.

Rows are in role order (top, jungle, mid, bottom, support) for both teams, so
the same row in the other team is the lane opponent. Champion names are small
on this screen, so they are matched against the ten champions known from the
draft rather than the whole champion list.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from itertools import permutations
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from rapidfuzz import fuzz

from . import layout as L
from .champions import letters

ROLES = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"]


@dataclass
class ScoreRow:
    name: str | None
    kills: int | None = None
    deaths: int | None = None
    assists: int | None = None
    role: str | None = None
    champ_raw: list[str] = field(default_factory=list)


@dataclass
class PostGame:
    result: str | None  # "VICTORY" / "DEFEAT" as shown, i.e. from the streamer's side
    game_type: str | None
    duration_s: int | None
    team1: list[ScoreRow] = field(default_factory=list)
    team2: list[ScoreRow] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# --- low-level OCR helpers ----------------------------------------------------------


def _ocr(img: np.ndarray, psm: int = 7, whitelist: str | None = None) -> str:
    cfg = f"--psm {psm} --oem 1"
    if whitelist:
        cfg += f" -c tessedit_char_whitelist={whitelist}"
    return pytesseract.image_to_string(img, config=cfg).strip()


def _prep(img: np.ndarray, target_h: int = 72, floor: int = 0) -> np.ndarray:
    """Light text on dark → black on white, scaled to a fixed height."""
    v = img.max(axis=2)
    f = target_h / max(img.shape[0], 1)
    v = cv2.resize(v, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    otsu, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, t = cv2.threshold(v, max(otsu, floor), 255, cv2.THRESH_BINARY)
    return cv2.copyMakeBorder(255 - t, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)


def _box(client: np.ndarray, x: tuple[float, float], y_center: float, half_h: float) -> np.ndarray:
    h, w = client.shape[:2]
    x0, y0, x1, y1 = L.px((x[0], y_center - half_h, x[1], y_center + half_h), w, h)
    return client[y0:y1, x0:x1]


# --- K/D/A ------------------------------------------------------------------------------


def _is_slash(comp: np.ndarray) -> bool:
    """A '/' is a thin stroke going up to the right: x and y strongly anti-correlated."""
    ys, xs = np.nonzero(comp)
    if len(xs) < 8 or xs.std() < 1 or ys.std() < 1:
        return False
    h, w = comp.shape
    return np.corrcoef(xs, ys)[0, 1] < -0.7 and 0.2 < w / h < 0.9


@lru_cache(maxsize=1)
def _digit_templates() -> np.ndarray:
    """10 templates (0–9), 16×24 each, made from real scoreboard digits (reference/digits.png)."""
    img = cv2.imread(str(L.REF_DIR / "digits.png"), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255
    return np.stack([img[:, i * 16 : (i + 1) * 16] for i in range(10)])


def _classify_digit(comp: np.ndarray) -> tuple[int, float]:
    t = _digit_templates()
    x = cv2.resize(comp.astype(np.float32), (16, 24), interpolation=cv2.INTER_AREA)
    xv = (x - x.mean()).ravel()
    best, best_s = 0, -1.0
    for d in range(10):
        tv = (t[d] - t[d].mean()).ravel()
        s = float(xv @ tv / (np.linalg.norm(xv) * np.linalg.norm(tv) + 1e-6))
        if s > best_s:
            best, best_s = d, s
    return best, best_s


def read_kda(img: np.ndarray) -> tuple[int, int, int] | None:
    """Reads "K / D / A": finds the slashes geometrically and classifies each digit against templates."""
    prepped = _prep(img, 72)
    ink = (prepped < 128).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 15 or h < prepped.shape[0] * 0.2:
            continue
        mask = (labels[y : y + h, x : x + w] == i).astype(np.uint8)
        comps.append((x, mask, _is_slash(mask)))
    comps.sort(key=lambda c: c[0])
    if sum(1 for c in comps if c[2]) != 2:
        return None

    numbers: list[str] = [""]
    for _, mask, slash in comps:
        if slash:
            numbers.append("")
            continue
        digit, score = _classify_digit(mask)
        if score < 0.55:
            return None
        numbers[-1] += str(digit)
    if len(numbers) != 3 or not all(numbers) or any(len(n) > 2 for n in numbers):
        return None
    k, d, a = (int(n) for n in numbers)
    return k, d, a


# --- reading the screen -------------------------------------------------------------------


def clean_name(raw: str) -> str | None:
    """Drops OCR noise around a player name (stray marks, short lowercase junk at the end)."""
    words = raw.strip(" |:;.,'\"‘’=-_*").split()
    while len(words) > 1 and re.fullmatch(r"[a-z]{1,3}|\W+", words[-1]):
        words.pop()
    name = " ".join(words).strip(" |:;.,'\"‘’=-_*")
    return name if len(name) >= 2 else None


def _read_row(client: np.ndarray, y: float) -> ScoreRow:
    name = clean_name(_ocr(_prep(_box(client, L.SB_NAME_X, y, L.SB_LINE_H / 2))))
    champ_img = _box(client, L.SB_NAME_X, y + L.SB_CHAMP_DY, L.SB_LINE_H / 2)
    raws = [_ocr(_prep(champ_img, floor=f)) for f in (0, 90)]
    row = ScoreRow(name, champ_raw=[r for r in raws if r])
    kda = read_kda(_box(client, L.SB_KDA_X, y, L.SB_LINE_H / 2))
    if kda:
        row.kills, row.deaths, row.assists = kda
    return row


def read_postgame(client_crop: np.ndarray, debug_dir: Path | None = None) -> PostGame:
    client = cv2.resize(client_crop, (L.CANON_W, L.CANON_H), interpolation=cv2.INTER_CUBIC)
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "postgame.png"), client)
    h, w = client.shape[:2]

    x0, y0, x1, y1 = L.px(L.RESULT_BOX, w, h)
    result_raw = letters(_ocr(_prep(client[y0:y1, x0:x1], 80)))
    result = None
    for word in ("VICTORY", "DEFEAT"):
        if word in result_raw or fuzz.ratio(result_raw, word) >= 70:
            result = word

    x0, y0, x1, y1 = L.px(L.SUBTITLE_BOX, w, h)
    sub = _ocr(_prep(client[y0:y1, x0:x1], 60))
    m = re.search(r"(\d{1,2})[:.](\d{2})", sub)
    duration = int(m.group(1)) * 60 + int(m.group(2)) if m else None
    gm = re.match(r"\W*([A-Za-z][A-Za-z/ ]*?)\s*(?:[-·•+|]|W\s*[:.]|\d|$)", sub)
    game_type = gm.group(1).strip() if gm and gm.group(1).strip() else None

    pg = PostGame(result, game_type, duration)
    for ys, team in ((L.TEAM1_NAME_Y, pg.team1), (L.TEAM2_NAME_Y, pg.team2)):
        for i, y in enumerate(ys):
            row = _read_row(client, y)
            row.role = ROLES[i]
            team.append(row)
    return pg


# --- combining with the draft ---------------------------------------------------------------


def _row_score(row: ScoreRow, champion: str) -> float:
    key = letters(champion)
    return max((fuzz.ratio(letters(r), key) for r in row.champ_raw), default=0.0)


def _best_assignment(rows: list[ScoreRow], champions: list[str]) -> tuple[list[str], float]:
    """Assigns the five known champions to the five rows (each used once), maximising OCR similarity."""
    matrix = [[_row_score(r, c) for c in champions] for r in rows]
    best, best_total = list(champions), -1.0
    for perm in permutations(range(len(champions))):
        total = sum(matrix[i][j] for i, j in enumerate(perm))
        if total > best_total:
            best, best_total = [champions[j] for j in perm], total
    return best, best_total / max(len(rows), 1)


def match_to_draft(pg: PostGame, ally: list[str], enemy: list[str]) -> dict | None:
    """Combines the scoreboard with the draft. Returns the post-game payload for the app, or None if it doesn't fit."""
    if len(ally) != 5 or len(enemy) != 5 or len(pg.team1) != 5 or len(pg.team2) != 5:
        return None
    # Which scoreboard team is the streamer's? Try both ways and keep the better fit.
    a1, s_a1 = _best_assignment(pg.team1, ally)
    e2, s_e2 = _best_assignment(pg.team2, enemy)
    a2, s_a2 = _best_assignment(pg.team2, ally)
    e1, s_e1 = _best_assignment(pg.team1, enemy)
    if s_a1 + s_e2 >= s_a2 + s_e1:
        ally_rows, enemy_rows, ally_ch, enemy_ch, fit = pg.team1, pg.team2, a1, e2, (s_a1 + s_e2) / 2
    else:
        ally_rows, enemy_rows, ally_ch, enemy_ch, fit = pg.team2, pg.team1, a2, e1, (s_a2 + s_e1) / 2
    if fit < 45:  # scoreboard of a different game, or unreadable
        return None

    def side(rows: list[ScoreRow], champs: list[str]) -> list[dict]:
        return [
            {"champion": c, "player_name": r.name, "role": r.role, "kills": r.kills, "deaths": r.deaths, "assists": r.assists, "lane": i}
            for i, (r, c) in enumerate(zip(rows, champs))
        ]

    return {
        "result": {"VICTORY": "WIN", "DEFEAT": "LOSS"}.get(pg.result or ""),
        "game_type": pg.game_type,
        "duration_s": pg.duration_s,
        "fit": round(fit, 1),
        "ally": side(ally_rows, ally_ch),
        "enemy": side(enemy_rows, enemy_ch),
    }
