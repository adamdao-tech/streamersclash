"""Find the League client's champion select screen in a video frame.

Uses multi-scale template matching on gradient images, comparing only the
static UI parts of the client (see layout.STATIC_REGIONS). Works on low
resolution frames (160p is enough), so scanning a VOD is cheap.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np

from .layout import REFERENCE_PATH, STATIC_REGIONS

# Score of a champ select frame is ~0.80–0.90, in-game frames stay below ~0.70.
DEFAULT_THRESHOLD = 0.74


@dataclass
class ClientRect:
    x: float
    y: float
    w: float
    h: float
    score: float

    def crop(self, frame: np.ndarray) -> np.ndarray:
        x0, y0 = max(int(self.x), 0), max(int(self.y), 0)
        x1 = min(int(self.x + self.w), frame.shape[1])
        y1 = min(int(self.y + self.h), frame.shape[0])
        return frame[y0:y1, x0:x1]

    def scaled(self, factor: float) -> "ClientRect":
        return ClientRect(self.x * factor, self.y * factor, self.w * factor, self.h * factor, self.score)


def _gradient(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
    return cv2.magnitude(gx, gy)


@lru_cache(maxsize=1)
def _reference() -> np.ndarray:
    ref = cv2.imread(str(REFERENCE_PATH))
    if ref is None:
        raise FileNotFoundError(REFERENCE_PATH)
    return ref


@lru_cache(maxsize=64)
def _template(tw: int, th: int) -> tuple[np.ndarray, np.ndarray]:
    t = cv2.resize(_reference(), (tw, th), interpolation=cv2.INTER_AREA)
    mask = np.zeros((th, tw), np.float32)
    for x0, y0, x1, y1 in STATIC_REGIONS:
        mask[int(y0 * th) : int(y1 * th) + 1, int(x0 * tw) : int(x1 * tw) + 1] = 1
    return _gradient(t), mask


def find_client(frame: np.ndarray, work_width: int = 480, min_frac: float = 0.35) -> ClientRect:
    """Best match of the champ select client in the frame (check .score against a threshold)."""
    ref_h, ref_w = _reference().shape[:2]
    work_width = min(work_width, frame.shape[1])
    s = work_width / frame.shape[1]
    small = cv2.resize(frame, (work_width, round(frame.shape[0] * s)), interpolation=cv2.INTER_AREA)
    grad = _gradient(small)

    best = ClientRect(0, 0, 0, 0, -1.0)
    for frac in np.arange(min_frac, 1.0001, 0.025):
        tw = int(work_width * frac)
        th = int(tw * ref_h / ref_w)
        if th > small.shape[0] or tw < 40:
            continue
        templ, mask = _template(tw, th)
        res = cv2.matchTemplate(grad, templ, cv2.TM_CCOEFF_NORMED, mask=mask)
        res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
        _, score, _, loc = cv2.minMaxLoc(res)
        if score > best.score:
            best = ClientRect(loc[0] / s, loc[1] / s, tw / s, th / s, float(score))
    return best


def is_champ_select(frame: np.ndarray, threshold: float = DEFAULT_THRESHOLD) -> tuple[bool, ClientRect]:
    rect = find_client(frame)
    return rect.score >= threshold, rect
