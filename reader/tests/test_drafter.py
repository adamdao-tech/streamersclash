"""drafter.lol on stream: bans and sides from a real VOD frame (fityr, scrim vs Nyx, game 1, 17. 11.).

Truth from the drafter.lol series ZF2as-8D: blue (Sgoob) banned Lulu, Seraphine, Wukong, Zoe, Malphite;
red (Nyx) Zac, Gwen, Lee Sin, Nautilus and left the fifth ban empty.

Needs the champion icons (downloaded by the reader into /cache) and network for the splash art:

    docker compose run --rm -v $PWD/tests:/app/tests --entrypoint python reader tests/test_drafter.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402

from scout_reader import drafter  # noqa: E402
from scout_reader.champions import ChampionDB  # noqa: E402
from scout_reader.detect import Finder  # noqa: E402
from scout_reader import video  # noqa: E402

cache = Path(os.environ.get("CACHE_DIR", "/cache"))
db = ChampionDB.load(cache)
frame = cv2.imread(str(Path(__file__).parent / "data" / "drafter_fityr_1822.jpg"))
assert frame is not None

# the scan finds the page at its 320 px
small = cv2.resize(frame, (video.SCAN_W, video.SCAN_H), interpolation=cv2.INTER_AREA)
f = Finder("drafter", work_width=video.SCAN_W)
r = f.find(small)
assert r.score >= f.threshold, r.score

reading = drafter.read_frame(frame, db, 1822)
assert reading, "page not found at full resolution"
print(reading.summary())
assert reading.ban_names("blue") == ["Lulu", "Seraphine", "Wukong", "Zoe", "Malphite"], reading.ban_names("blue")
assert reading.ban_names("red") == ["Zac", "Gwen", "Lee Sin", "Nautilus"], reading.ban_names("red")
assert reading.bans["red"][4].champion is None  # the empty slot stays empty

ally = ["Nasus", "Jarvan IV", "Galio", "Caitlyn", "Karma"]  # our team (POV fityr)
enemy = ["Skarner", "Xin Zhao", "Cassiopeia", "Lucian", "Milio"]
side, agree = drafter.ally_side(reading, ally, enemy, db, cache)
print("streamer's team on", side, f"({agree}/10)")
assert side == "blue" and agree >= 8
assert drafter.ally_side(reading, enemy, ally, db, cache)[0] == "red"

got = drafter.bans_for([reading], 1900, ally, enemy, db, cache)
assert got and got[0][:5] == ["Lulu", "Seraphine", "Wukong", "Zoe", "Malphite"] and got[1] == ["Zac", "Gwen", "Lee Sin", "Nautilus"]
# a draft whose picks aren't this game's isn't used
assert drafter.bans_for([reading], 1900, ["Ahri", "Lee Sin", "Jinx", "Thresh", "Garen"], ["Zed", "Vi", "Orianna", "Ezreal", "Leona"], db, cache) is None
print("OK")
