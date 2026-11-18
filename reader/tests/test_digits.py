"""K/D/A digits: 0, 6, 8 and 9 are told apart by their enclosed areas (no network).

    python3 tests/test_digits.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from scout_reader.postgame import _classify_digit, _digit_templates, read_kda  # noqa: E402

t = _digit_templates()
for d in range(10):
    for size in [(14, 21), (16, 24), (24, 36), (30, 45)]:
        comp = cv2.resize((t[d] > 0.5).astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)
        assert _classify_digit(comp)[0] == d, (d, size)
for text in ["1 / 6 / 6", "11 / 2 / 6", "0 / 6 / 10", "6 / 0 / 9", "8 / 9 / 16"]:
    img = np.zeros((30, 170, 3), np.uint8)
    cv2.putText(img, text, (4, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (220, 220, 220), 2, cv2.LINE_AA)
    assert read_kda(img) == tuple(int(x) for x in text.split("/")), text
print("OK")
