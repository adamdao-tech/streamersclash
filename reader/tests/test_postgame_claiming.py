"""Which post-game screens are read on their own (no network, no images).

    python3 tests/test_postgame_claiming.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # reader/ (or /app in the image)

from scout_reader import scan as S  # noqa: E402

E = S.Episode
real = E("champselect", 1000, 1100, 10)        # a real draft that reads
fake = E("champselect", 1500, 1510, 6)         # in-game frame the scan took for a champ select (rejected at 1080p)
pg = E("postgame", 2900, 2950, 5)              # the real draft's scoreboard
unreadable = E("champselect", 5400, 5500, 10)  # a real champ select that doesn't read
pg2 = E("postgame", 7400, 7420, 3)             # its scoreboard
scan = S.ScanResult([real, fake, unreadable], [pg, pg2])

# before: the fake find stood between the draft and its scoreboard, and the unreadable draft claimed pg2 → both lost
assert S.postgame_for(real, scan) is None
only_real = S.real_drafts(scan, [S.DraftResult(real, 1099, None, b"", 0, 0)])
assert S.postgame_for(real, only_real) is pg, "a false champ select find must not hide the draft's scoreboard"
assert S.unused_postgames(scan, {id(pg)}) == [pg2], "a scoreboard no draft used is read on its own"
assert S.unused_postgames(scan, set()) == [pg, pg2]
print("OK")
