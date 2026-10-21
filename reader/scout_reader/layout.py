"""Geometry of the League client's champion select screen.

All coordinates are normalised to the client window (0..1 in x and y), measured
on a 16:9 client. The client can sit anywhere in the stream layout and at any
size; detect.py finds its rectangle, and these coordinates are relative to it.
"""

from pathlib import Path

REFERENCE_PATH = Path(__file__).parent / "reference" / "champselect.png"

# Canonical size the client crop is resized to before reading.
CANON_W, CANON_H = 1600, 900

# UI parts that look the same in every champion select phase (picking, banning,
# loadout). Only these are compared during detection; champions, names and the
# centre art are ignored.
STATIC_REGIONS = [
    (0.015, 0.915, 0.275, 0.985),  # chat input box, bottom left
    (0.775, 0.915, 0.985, 0.985),  # QUIT button + buttons, bottom right
    (0.000, 0.105, 0.300, 0.115),  # divider under our bans
    (0.700, 0.105, 1.000, 0.115),  # divider under enemy bans
]

# Ban icons: centres of the five icons on each side, and the icon size.
BAN_Y = 0.069
BAN_SIZE = (0.021, 0.038)  # width, height
ALLY_BAN_X = [0.027, 0.057, 0.088, 0.118, 0.148]
ENEMY_BAN_X = [0.848, 0.879, 0.910, 0.941, 0.972]

# Pick slots: vertical centre of the champion-name line in each of the 5 rows.
ALLY_ROW_Y = [0.187 + 0.110 * i for i in range(5)]
ENEMY_ROW_Y = [0.190 + 0.1095 * i for i in range(5)]

# Text block of a slot (role line above the champion, player name below).
ALLY_TEXT_X = (0.098, 0.262)
ENEMY_TEXT_X = (0.760, 0.925)
ROW_TEXT_UP, ROW_TEXT_DOWN = 0.052, 0.046
# Just the champion-name line.
NAME_HALF_H = 0.019


def px(rect, w, h):
    """Normalised (x0, y0, x1, y1) → integer pixel box for an image of size w×h."""
    x0, y0, x1, y1 = rect
    return int(x0 * w), int(y0 * h), int(round(x1 * w)), int(round(y1 * h))
