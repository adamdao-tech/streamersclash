"""Find League client screens (champion select, post-game) in a video frame.

Multi-scale template matching on gradient images, comparing only UI parts that
never change on that screen (see layout.SCREENS). Works on low resolution
frames (160p is enough), so scanning a whole VOD is cheap. Once the client has
been found, later frames are checked at the same place first (fast path).
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np

from .layout import SCREENS

# Score of a matching frame is ~0.80–0.90; other screens and in-game frames stay below ~0.70.
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


def _gradient(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
    return cv2.magnitude(gx, gy)


@lru_cache(maxsize=4)
def _reference(screen: str) -> np.ndarray:
    path = SCREENS[screen]["reference"]
    ref = cv2.imread(str(path))
    if ref is None:
        raise FileNotFoundError(path)
    return ref


@lru_cache(maxsize=256)
def _template(screen: str, tw: int, th: int) -> tuple[np.ndarray, np.ndarray]:
    t = cv2.resize(_reference(screen), (tw, th), interpolation=cv2.INTER_AREA)
    mask = np.zeros((th, tw), np.float32)
    for x0, y0, x1, y1 in SCREENS[screen]["regions"]:
        mask[int(y0 * th) : int(y1 * th) + 1, int(x0 * tw) : int(x1 * tw) + 1] = 1
    return _gradient(t), mask


def _match(grad: np.ndarray, screen: str, tw: int, th: int) -> tuple[float, tuple[int, int]]:
    templ, mask = _template(screen, tw, th)
    res = cv2.matchTemplate(grad, templ, cv2.TM_CCOEFF_NORMED, mask=mask)
    res = np.nan_to_num(res, nan=0.0, posinf=0.0, neginf=0.0)
    _, score, _, loc = cv2.minMaxLoc(res)
    return float(score), loc


class Finder:
    """Finds a client screen in frames of one video, remembering where the client was last seen."""

    def __init__(self, screen: str, work_width: int = 480, min_frac: float = 0.35, full_search_every: int = 1):
        self.screen = screen
        self.work_width = work_width
        self.min_frac = min_frac
        self.hint: ClientRect | None = None  # in original frame pixels
        # When the client position is known, the slow full search runs only every N-th frame:
        # stream layouts rarely change, and every screen we look for lasts far longer than N frames.
        self.full_search_every = full_search_every
        self._since_full = 0

    @property
    def threshold(self) -> float:
        return float(SCREENS[self.screen].get("threshold", DEFAULT_THRESHOLD))

    def find(self, frame: np.ndarray, threshold: float | None = None) -> ClientRect:
        threshold = self.threshold if threshold is None else threshold
        work_width = min(self.work_width, frame.shape[1])
        s = work_width / frame.shape[1]
        small = cv2.resize(frame, (work_width, round(frame.shape[0] * s)), interpolation=cv2.INTER_AREA)
        grad = _gradient(small)

        # Fast path: same size and roughly the same place as last time.
        if self.hint:
            tw, th = round(self.hint.w * s), round(self.hint.h * s)
            pad = max(4, round(tw * 0.03))
            x0, y0 = max(round(self.hint.x * s) - pad, 0), max(round(self.hint.y * s) - pad, 0)
            x1, y1 = min(x0 + tw + 2 * pad, grad.shape[1]), min(y0 + th + 2 * pad, grad.shape[0])
            if x1 - x0 >= tw and y1 - y0 >= th:
                score, loc = _match(grad[y0:y1, x0:x1], self.screen, tw, th)
                if score >= threshold:
                    rect = ClientRect((x0 + loc[0]) / s, (y0 + loc[1]) / s, tw / s, th / s, score)
                    self.hint = rect
                    return rect
            self._since_full += 1
            if self._since_full < self.full_search_every:
                return ClientRect(0, 0, 0, 0, score if x1 - x0 >= tw and y1 - y0 >= th else -1.0)
        self._since_full = 0

        ref_h, ref_w = _reference(self.screen).shape[:2]
        best = ClientRect(0, 0, 0, 0, -1.0)
        for frac in np.arange(self.min_frac, 1.0001, 0.025):
            tw = int(work_width * frac)
            th = int(tw * ref_h / ref_w)
            if th > small.shape[0] or tw < 40:
                continue
            score, loc = _match(grad, self.screen, tw, th)
            if score > best.score:
                best = ClientRect(loc[0] / s, loc[1] / s, tw / s, th / s, score)
        if best.score >= threshold:
            self.hint = best
        return best


def find_client(frame: np.ndarray, work_width: int = 480, screen: str = "champselect") -> ClientRect:
    """One-off search (no memory between frames)."""
    return Finder(screen, work_width).find(frame)


def is_screen(frame: np.ndarray, screen: str, work_width: int = 640) -> tuple[bool, ClientRect]:
    f = Finder(screen, work_width)
    rect = f.find(frame)
    return rect.score >= f.threshold, rect
