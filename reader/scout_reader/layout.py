"""Geometry of the League client's champion select screen.

All coordinates are normalised to the client window (0..1 in x and y), measured
on a 16:9 client. The client can sit anywhere in the stream layout and at any
size; detect.py finds its rectangle, and these coordinates are relative to it.
"""

from pathlib import Path

REF_DIR = Path(__file__).parent / "reference"

# Canonical size the client crop is resized to before reading.
CANON_W, CANON_H = 1600, 900

# For each screen: a reference screenshot of the client and the UI parts that
# look the same every time. Only those parts are compared during detection;
# champions, names and art are ignored.
SCREENS = {
    "champselect": {
        "reference": REF_DIR / "champselect.png",
        "threshold": 0.74,
        "min_hits": 3,  # a real champ select lasts at least ~15 s
        "regions": [
            (0.015, 0.915, 0.275, 0.985),  # chat input box, bottom left
            (0.775, 0.915, 0.985, 0.985),  # QUIT button + buttons, bottom right
            (0.000, 0.105, 0.300, 0.115),  # divider under our bans
            (0.700, 0.105, 1.000, 0.115),  # divider under enemy bans
        ],
    },
    "postgame": {
        "reference": REF_DIR / "postgame.png",
        "threshold": 0.65,
        "min_hits": 2,
        "regions": [
            (0.030, 0.140, 0.105, 0.166),  # "SCOREBOARD" label
            (0.620, 0.042, 0.800, 0.088),  # "VIEW ADVANCED DETAILS" button
            (0.340, 0.905, 0.488, 0.975),  # "PLAY AGAIN" button
            (0.030, 0.915, 0.280, 0.965),  # chat input box
        ],
    },
}
STATIC_REGIONS = SCREENS["champselect"]["regions"]

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


# --- post-game scoreboard ---------------------------------------------------------
RESULT_BOX = (0.050, 0.022, 0.215, 0.088)  # "VICTORY" / "DEFEAT"
SUBTITLE_BOX = (0.050, 0.072, 0.320, 0.102)  # "Custom · W:0 - L:0 · 31:01 · GameID"
# Centre of the player-name line in each scoreboard row; the champion name is just below.
TEAM1_NAME_Y = [0.239 + 0.0565 * i for i in range(5)]
TEAM2_NAME_Y = [0.569 + 0.0567 * i for i in range(5)]
SB_NAME_X = (0.150, 0.305)
SB_KDA_X = (0.548, 0.632)
SB_LINE_H = 0.024  # height of one text line
SB_CHAMP_DY = 0.021  # champion line below the name line
