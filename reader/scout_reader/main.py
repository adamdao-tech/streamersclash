"""Draft reader entry point.

  run                          poll the app for new VODs and process them (default)
  scan <vod-url> [--start --end]   find champ selects in a VOD and read them, print only
  test <vod-url> <time>        read the draft at one moment (e.g. 27:00), save debug images
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from . import drafter as D
from . import kick
from . import scan as S
from . import video
from .app_api import AppClient
from .champions import ChampionDB

log = logging.getLogger("reader")


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        sys.exit(f"Missing environment variable {name} (see .env.example)")
    return value


def parse_time(s: str) -> float:
    """'1:02:03', '27:00' or '1620' → seconds"""
    parts = [float(p) for p in s.split(":")]
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def load_champions() -> ChampionDB:
    cache = Path(env("CACHE_DIR", "/cache"))
    offline = os.environ.get("CHAMPIONS_FILE")
    return ChampionDB.load(cache, Path(offline) if offline else None)


def postgame_summary(pg: dict | None) -> str:
    if not pg:
        return "post-game: scoreboard doesn't match this draft"
    def side(rows):
        return ", ".join(f"{r['champion']} {r['player_name'] or '?'} {r['kills']}/{r['deaths']}/{r['assists']}" for r in rows)
    return (f"post-game: {pg['result']} · {pg['game_type']} · {pg['duration_s']}s (fit {pg['fit']})\n"
            f"  ally:  {side(pg['ally'])}\n  enemy: {side(pg['enemy'])}")


def summary(reading) -> str:
    def side(slots):
        return ", ".join(f"{s.champion or '?'}({s.score:.0f})" for s in slots)

    return f"ALLY [{side(reading.ally)}]  vs  ENEMY [{side(reading.enemy)}]  conf={reading.confidence}"


def cmd_test(args) -> None:
    db = load_champions()
    streams = video.resolve(args.url)
    debug = Path(env("DEBUG_DIR", "/debug")) / f"test_{int(parse_time(args.at))}"
    got = S.read_at(streams, parse_time(args.at), db, debug)
    if not got:
        # show how close it was, so a layout problem (cam over the client…) can be told from a wrong time
        from .detect import is_screen

        import cv2

        from .detect import Finder

        frame = video.grab_frame(streams.hires_url, parse_time(args.at))
        _, rect = is_screen(frame, "champselect")
        print(f"Champion select not found at this moment (best match {rect.score:.2f}, needed "
              f"{0.74:.2f}). Try a few seconds earlier/later; a low score on a real champ select "
              "means the stream layout hides the client (e.g. a webcam over it).")
        # the same frame as the scan sees it (320 px) and as a post-game screen
        small = cv2.resize(frame, (video.SCAN_W, video.SCAN_H), interpolation=cv2.INTER_AREA)
        for screen in ("champselect", "postgame"):
            f = Finder(screen, video.SCAN_W)
            r = f.find(small)
            print(f"  scan view {screen}: {r.score:.2f} (needed {f.threshold:.2f}) at x={r.x:.0f} y={r.y:.0f} w={r.w:.0f} h={r.h:.0f}")
        debug.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug / "frame.jpg"), frame)
        cv2.imwrite(str(debug / "scan_view.png"), small)
        print(f"Frame saved: {debug / 'frame.jpg'}")
        return
    reading, crop = got
    print(summary(reading))
    if args.verbose:
        print(json.dumps(reading.to_payload(include_unsure_bans=True), indent=2, ensure_ascii=False))
    postgame, pg_jpeg = None, None
    if args.postgame:
        ally = [s.champion for s in reading.ally if s.champion]
        enemy = [s.champion for s in reading.enemy if s.champion]
        pg = S.read_postgame_at(streams, parse_time(args.postgame), ally, enemy, debug)
        if not pg:
            print("Post-game screen not found at this moment.")
        else:
            print(postgame_summary(pg[0]))
            if pg[0]:
                postgame = {**pg[0], "ts_s": int(parse_time(args.postgame))}
                pg_jpeg = S._jpeg(pg[1])[0]
    print(f"Debug images: {debug}")

    if args.upload:
        app = AppClient(env("APP_URL"), env("READER_TOKEN"))
        payload = reading.to_payload()
        if postgame:
            payload["postgame"] = postgame
        jpg, w, h = S._jpeg(crop)
        r = app.upload_frame(
            None, parse_time(args.at), jpg, w, h, payload, reading.confidence, reading.picks_confident,
            postgame_jpeg=pg_jpeg, vod_url=args.url,
        )
        if r.get("duplicate"):
            print("Uploaded: this game was already in the app" + (", updated it." if r.get("updated") else "."))
        elif r.get("match_id"):
            print(f"Uploaded: saved as game #{r['match_id']}.")
        else:
            print(f"Uploaded for review: {r.get('reason')}")


def cmd_scan(args) -> None:
    db = load_champions()
    streams = video.resolve(args.url)
    every = float(env("SAMPLE_SECONDS", "2"))
    scan = S.find_episodes(streams, every, parse_time(args.start) if args.start else 0, parse_time(args.end) if args.end else None)
    print(f"Found {len(scan.drafts)} champion select(s), {len(scan.postgames)} post-game screen(s), "
          f"{len(scan.drafters)} drafter.lol page(s)")
    debug = Path(env("DEBUG_DIR", "/debug"))
    cache_dir = Path(env("CACHE_DIR", "/cache"))
    drafters = read_drafters(streams, scan, db, debug)
    for d in drafters:
        print(f"  {S.fmt(d.ts)}: drafter.lol – {d.summary()}")
    used: set[int] = set()
    read = {id(ep): S.read_draft_episode(streams, ep, db, debug) for ep in scan.drafts}
    real = S.real_drafts(scan, [r for r in read.values() if r])
    for ep in scan.drafts:
        res = read[id(ep)]
        if res:
            S.attach_postgame(streams, res, db, real, debug)
        print(f"  {S.fmt(ep.start)}–{S.fmt(ep.end)}: " + (summary(res.reading) if res else "could not read (false find or unreadable)"))
        if res:
            print("  " + postgame_summary(res.postgame) if res.postgame_ts else "  no post-game screen (dodge or game not finished in VOD)")
            enemy = [s.champion for s in res.reading.enemy if s.champion] or [r["champion"] for r in (res.postgame or {}).get("enemy", []) if r.get("champion")]
            got = D.bans_for(drafters, ep.start, [s.champion for s in res.reading.ally if s.champion], enemy, db, cache_dir)
            if got:
                print(f"  bans (drafter.lol): ours {', '.join(got[0]) or '–'} | theirs {', '.join(got[1]) or '–'}")
            if res.postgame_ep and res.postgame:
                used.add(id(res.postgame_ep))
    for pg_ep in S.unused_postgames(scan, used):
        got = S.best_open_postgame(streams, pg_ep, db, None, debug)
        print(f"  {S.fmt(pg_ep.start)}: post-game without a draft – " + (postgame_summary(got[0]) if got else "unreadable"))
        if got:
            pg, ts = got[0], got[1]
            b = D.bans_for(drafters, ts - (pg.get("duration_s") or 2400) - 240,
                           [r["champion"] for r in pg["ally"] if r.get("champion")], [r["champion"] for r in pg["enemy"] if r.get("champion")], db, cache_dir)
            if b:
                print(f"  bans (drafter.lol): team 1 {', '.join(b[0]) or '–'} | team 2 {', '.join(b[1]) or '–'}")


def read_drafters(streams: video.Streams, scan: S.ScanResult, db: ChampionDB, debug_root: Path | None = None) -> list:
    """drafter.lol drafts seen in the VOD, read at full resolution (bans + pick panels)."""
    out = []
    for ep in scan.drafters:
        r = D.read_episode(streams, ep, db, debug_root)
        if r:
            log.info("  %s: drafter.lol draft – %s", S.fmt(r.ts), r.summary())
            out.append(r)
    return out


def add_drafter_bans(payload: dict, drafters: list, game_start: float, db: ChampionDB, cache_dir: Path) -> None:
    """Bans from the drafter.lol draft before this game, when the client showed none (blind-pick customs).
    The pick panels must show this game's champions – that also says which side was whose."""
    if not drafters or payload.get("ally_bans") or payload.get("enemy_bans"):
        return
    ally = [s["champion"] for s in payload.get("ally", []) if s.get("champion") not in (None, "?")]
    enemy = [s["champion"] for s in payload.get("enemy", []) if s.get("champion") not in (None, "?")]
    got = D.bans_for(drafters, game_start, ally, enemy, db, cache_dir)
    if got:
        payload["ally_bans"], payload["enemy_bans"], line = got
        payload["bans_source"] = "drafter.lol"
        log.info("  %s", line)


def process_job(app: AppClient, db: ChampionDB, job: dict, auto_accept: bool, every: float) -> None:
    vod_id = job["id"]
    log.info("VOD %s: %s (%s)", vod_id, job.get("title"), job["url"])
    try:
        streams = video.resolve(job["url"], job.get("stream_url"), job.get("duration_s"), job.get("title"))
    except Exception as e:  # sub-only, deleted, region-locked…
        log.warning("  cannot open VOD: %s", e)
        app.finish_job(vod_id, "failed", error=str(e)[:500])
        return

    scan = S.find_episodes(streams, every)
    log.info("  %d champion select(s), %d post-game screen(s) found", len(scan.drafts), len(scan.postgames))
    cache_dir = Path(env("CACHE_DIR", "/cache"))
    drafters = read_drafters(streams, scan, db)
    found = 0
    used: set[int] = set()  # post-game screens a saved draft took; every other one is read on its own below
    read = {id(ep): S.read_draft_episode(streams, ep, db) for ep in scan.drafts}
    real = S.real_drafts(scan, [r for r in read.values() if r])
    rejected = len(scan.drafts) - len(real.drafts)
    if rejected:
        # mostly in-game frames the low-res scan took for a champ select; the full-resolution check throws them out
        log.info("  %d champ select find(s) rejected at full resolution (in-game frames or unreadable)", rejected)
    for ep in scan.drafts:
        res = read[id(ep)]
        if not res:
            log.debug("  %s: champ select couldn't be read, skipped", S.fmt(ep.end))
            continue
        S.attach_postgame(streams, res, db, real)
        payload = res.reading.to_payload()
        auto = auto_accept and res.reading.picks_confident
        if res.postgame and res.postgame.get("open"):
            # Blind pick: the enemy team comes from the scoreboard. Saved right away only when every champion is clear.
            payload["enemy"] = [{"champion": r["champion"] or "?"} for r in res.postgame["enemy"]]
            ally_ok = all(s.champion and s.score >= 90 for s in res.reading.ally)
            enemy_ok = all(r["champion"] and r.get("score", 0) >= 90 for r in res.postgame["enemy"])
            auto = auto_accept and ally_ok and enemy_ok
            log.info("  %s: blind pick – enemy team read from the post-game screen", S.fmt(ep.end))
        picks = sum(1 for side in ("ally", "enemy") for s in payload[side] if s["champion"] != "?")
        if picks < 6:
            log.info("  %s: no full draft (dodge, blind pick without a post-game screen, or unreadable), skipped", S.fmt(ep.end))
            continue
        if res.postgame:
            payload["postgame"] = {**res.postgame, "ts_s": int(res.postgame_ts or 0)}
        add_drafter_bans(payload, drafters, res.episode.start, db, cache_dir)
        r = app.upload_frame(
            vod_id, res.ts, res.client_jpeg, res.width, res.height, payload, res.reading.confidence, auto,
            postgame_jpeg=res.postgame_jpeg,
        )
        found += 1
        if res.postgame and res.postgame_ep:
            used.add(id(res.postgame_ep))
        if r.get("duplicate"):
            state = "already saved, updated" if r.get("updated") else "already saved"
        else:
            state = "saved" if r.get("match_id") else f"for review ({r.get('reason')})"
        log.info("  %s: %s → %s", S.fmt(res.ts), summary(res.reading), state)
        if res.postgame:
            log.info("  %s", postgame_summary(res.postgame))

    # Games whose draft never showed up in the client (drafted on drafter.lol and so on), whose champ select
    # couldn't be read, or that a false champ-select find sat in front of: the post-game screen alone gives all
    # ten champions, names, K/D/A and the result (no bans). The app keeps only team games and works out which
    # scoreboard team is the streamer's; saved right away when every champion is clear.
    seen: set[tuple] = set()
    for pg_ep in S.unused_postgames(scan, used):
        got = S.best_open_postgame(streams, pg_ep, db, None)
        if got:
            sig = tuple(sorted(f"{r['champion']}:{r['kills']}/{r['deaths']}/{r['assists']}" for r in got[0]["ally"] + got[0]["enemy"]))
            if sig in seen:  # the same scoreboard seen again later in the VOD
                continue
            seen.add(sig)
        if not got:
            log.info("  %s: post-game screen without a draft, unreadable – skipped", S.fmt(pg_ep.start))
            continue
        pg, ts, jpg, w, h = got
        payload = {
            "ally": [{"champion": r["champion"] or "?", "player_name": r["player_name"], "role": r["role"]} for r in pg["ally"]],
            "enemy": [{"champion": r["champion"] or "?"} for r in pg["enemy"]],
            "ally_bans": [],
            "enemy_bans": [],
            "postgame": {**pg, "ts_s": int(ts)},
            "source": "postgame",
        }
        # the game started about its length (plus loading) before the scoreboard
        add_drafter_bans(payload, drafters, ts - (pg.get("duration_s") or 2400) - 240, db, cache_dir)
        clear = all(r["champion"] and r.get("score", 0) >= 90 for r in pg["ally"] + pg["enemy"])
        r = app.upload_frame(vod_id, ts, jpg, w, h, payload, round(pg["fit"] / 100, 3), auto_accept and clear, postgame_jpeg=jpg)
        found += 1
        state = ("already saved" if r.get("duplicate") else "saved" if r.get("match_id")
                 else "not a team game, skipped" if r.get("skipped") else f"for review ({r.get('reason')})")
        log.info("  %s: game from the post-game screen only → %s", S.fmt(ts), state)
        log.info("  %s", postgame_summary(pg))
    app.finish_job(vod_id, "done" if found else "skipped", drafts_found=found)


def cmd_kick_sync(_args) -> None:
    app = AppClient(env("APP_URL"), env("READER_TOKEN"))
    synced, added = kick.sync(app)
    log.info("Kick: %d channel(s) checked, %d new VOD(s)", synced, added)


def worker(n: int, every: float, poll: float, auto_accept: bool, db: ChampionDB) -> None:
    """One scanning loop: claims a VOD, reads it, repeats. Several run side by side (WORKERS)."""
    app = AppClient(env("APP_URL"), env("READER_TOKEN"))
    while True:
        try:
            jobs = app.claim_jobs(1)
            if not jobs:
                time.sleep(poll)
                continue
            for job in jobs:
                try:
                    process_job(app, db, job, auto_accept, every)
                except Exception as e:
                    log.exception("  VOD %s failed", job["id"])
                    app.finish_job(job["id"], "failed", error=str(e)[:500])
        except Exception:
            log.exception("Worker %d: polling failed; retrying in %ds", n, poll)
            time.sleep(poll)


def cmd_run(_args) -> None:
    app = AppClient(env("APP_URL"), env("READER_TOKEN"))
    every = float(env("SAMPLE_SECONDS", "2"))
    poll = float(env("POLL_SECONDS", "300"))
    auto_accept = env("AUTO_ACCEPT", "true").lower() in ("1", "true", "yes")
    kick_every = float(env("KICK_SYNC_SECONDS", "900"))
    workers = max(1, int(env("WORKERS", "3")))
    db = load_champions()
    log.info("Reader started, polling %s every %ds, %d VOD(s) at a time", env("APP_URL"), poll, workers)
    # VODs are read in parallel: each worker thread claims its own VOD (ffmpeg and OpenCV do the heavy work
    # outside the GIL). The main thread only syncs Kick.
    for n in range(workers):
        threading.Thread(target=worker, args=(n + 1, every, poll, auto_accept, db), daemon=True, name=f"worker-{n + 1}").start()
        time.sleep(2)  # spread the first claims a little
    try:
        while True:
            # Kick VODs: their API blocks Cloudflare, so the reader fetches them and sends them to the app.
            if kick_every > 0:
                try:
                    synced, added = kick.sync(app)
                    if synced:
                        log.info("Kick: %d channel(s) checked, %d new VOD(s)", synced, added)
                except Exception:
                    log.exception("Kick sync failed")
            time.sleep(kick_every if kick_every > 0 else 3600)
    except KeyboardInterrupt:
        pass


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(threadName)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="reader", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("run")
    t = sub.add_parser("test")
    t.add_argument("url")
    t.add_argument("at", help="time of the finished draft in the VOD, e.g. 27:00 or 1:27:00")
    t.add_argument("--postgame", help="time of the post-game scoreboard, e.g. 1:00:00")
    t.add_argument("--upload", action="store_true", help="save the result to the app")
    t.add_argument("-v", "--verbose", action="store_true", help="print the full reading as JSON")
    sub.add_parser("kick-sync", help="fetch Kick VODs once and send them to the app")
    sc = sub.add_parser("scan")
    sc.add_argument("url")
    sc.add_argument("--start")
    sc.add_argument("--end")
    args = p.parse_args()
    {"test": cmd_test, "scan": cmd_scan, "kick-sync": cmd_kick_sync}.get(args.cmd, cmd_run)(args)


if __name__ == "__main__":
    main()
