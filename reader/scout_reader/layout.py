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
        "min_seconds": 12,  # a real champ select is on screen far longer than this
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
        # in blind-pick customs streamers often click "Play again" within seconds: one sampled frame is enough
        # (the frame is checked again at full resolution and its scoreboard must read before anything is saved)
        "min_seconds": 0,
        # A client filling the whole stream (fullscreen, webcam over the chat box) scores lower at the scan's
        # 320 px: such weaker matches count too, but each is confirmed by reading the scoreboard in full resolution.
        # a scoreboard left on screen for minutes is one game: sightings up to this far apart are merged
        "merge_gap_s": 180,
        # A weak match must also be a big window: false ones (Discord, lobby, mode select, in-game menus) come out
        # at the smallest searched size (~35 % of the stream), real scoreboards at the client's size. 0.5 lets in a
        # client beside a webcam/chat column (~55–60 % of the stream), which 0.6 used to drop.
        "candidate_threshold": 0.52,
        "candidate_min_frac": 0.5,
        "regions": [
            (0.030, 0.140, 0.105, 0.166),  # "SCOREBOARD" label
            (0.620, 0.042, 0.800, 0.088),  # "VIEW ADVANCED DETAILS" button
            (0.340, 0.905, 0.488, 0.975),  # "PLAY AGAIN" button
            (0.030, 0.915, 0.280, 0.965),  # chat input box
        ],
        # the chat box sits where most streamers put their webcam: the screen is also found without it
        "optional": 3,
    },
    # drafter.lol – the draft tool many teams use for scrims; in the client those games are blind pick (no bans).
    # Reference: the page's two pick columns (5 champion splashes each) and the ban rows under them, as a
    # browser shows them on a wide screen. Only the parts that look the same in every draft are compared: the
    # dark gaps between the pick panels, the columns' side edges and the ban slots.
    "drafter": {
        "reference": REF_DIR / "drafter.png",
        # a finished draft scores ~0.6–0.75 at the scan's 320 px, other screens stay under ~0.4
        "threshold": 0.5,
        # the page is a big browser window (or a Discord screen share of one): smaller finds are something else
        "min_frac": 0.45,
        # its own window – it doesn't share where it is with the client screens
        "own_window": True,
        "min_seconds": 0,
        "merge_gap_s": 60,
        # a draft there takes minutes: a look every ~6 s is plenty (keeps the scan almost as fast as before)
        "check_every_s": 6,
        "regions": [
            *[(x0, y - 0.0076, x1, y + 0.0076)
              for x0, x1 in ((0.0064, 0.3423), (0.6577, 0.9936))
              for y in (0.0106, 0.1864, 0.3652, 0.5455, 0.7242, 0.9061)],
            *[(x - 0.0032, 0.0106, x + 0.0032, 0.9061) for x in (0.0051, 0.3436, 0.6564, 0.9949)],
            *[(x - 0.0176, 0.9106, x + 0.0176, 0.9939)
              for x in (0.0205, 0.0526, 0.0849, 0.1199, 0.1519, 0.8516, 0.8837, 0.9196, 0.9516, 0.9837)],
        ],
    },
}
STATIC_REGIONS = SCREENS["champselect"]["regions"]

# --- drafter.lol page (coordinates relative to the found page rectangle, see SCREENS["drafter"]) -----------
# Pick panels: tops/bottoms of the five rows (the gaps between them), x range of the blue (left) and red columns.
DRAFTER_ROWS = [0.0106, 0.1864, 0.3652, 0.5455, 0.7242, 0.9061]
DRAFTER_COLS = {"blue": (0.0064, 0.3423), "red": (0.6577, 0.9936)}
# Ban slots, left to right on screen. Blue shows bans 1–5 left to right, red mirrored (5 → 1).
DRAFTER_BAN_X = {"blue": [0.0205, 0.0526, 0.0849, 0.1199, 0.1519], "red": [0.9837, 0.9516, 0.9196, 0.8837, 0.8516]}
DRAFTER_BAN_Y = 0.9523
DRAFTER_BAN_SIZE = (0.0276, 0.0652)  # width, height

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
RESULT_BOX_TIGHT = (0.055, 0.022, 0.200, 0.075)  # without the subtitle line below (streams scaled a bit differently)
SUBTITLE_BOX = (0.050, 0.072, 0.320, 0.102)  # "Custom · W:0 - L:0 · 31:01 · GameID"
# Centre of the player-name line in each scoreboard row; the champion name is just below.
TEAM1_NAME_Y = [0.239 + 0.0565 * i for i in range(5)]
TEAM2_NAME_Y = [0.569 + 0.0567 * i for i in range(5)]
SB_NAME_X = (0.150, 0.305)
SB_KDA_X = (0.548, 0.632)
SB_LINE_H = 0.024  # height of one text line
SB_CHAMP_DY = 0.021  # champion line below the name line
