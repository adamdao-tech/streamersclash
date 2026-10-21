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
import time
from pathlib import Path

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
        print("Champion select not found at this moment (try a few seconds earlier/later).")
        return
    reading, _ = got
    print(summary(reading))
    print(json.dumps(reading.to_payload(include_unsure_bans=True), indent=2, ensure_ascii=False))
    if args.postgame:
        ally = [s.champion for s in reading.ally if s.champion]
        enemy = [s.champion for s in reading.enemy if s.champion]
        pg = S.read_postgame_at(streams, parse_time(args.postgame), ally, enemy, debug)
        if not pg:
            print("Post-game screen not found at this moment.")
        else:
            print(postgame_summary(pg[0]))
    print(f"Debug images: {debug}")


def cmd_scan(args) -> None:
    db = load_champions()
    streams = video.resolve(args.url)
    every = float(env("SAMPLE_SECONDS", "5"))
    scan = S.find_episodes(streams, every, parse_time(args.start) if args.start else 0, parse_time(args.end) if args.end else None)
    print(f"Found {len(scan.drafts)} champion select(s), {len(scan.postgames)} post-game screen(s)")
    debug = Path(env("DEBUG_DIR", "/debug"))
    for ep in scan.drafts:
        res = S.read_episode(streams, ep, db, scan, debug)
        print(f"  {S.fmt(ep.start)}–{S.fmt(ep.end)}: " + (summary(res.reading) if res else "could not read"))
        if res:
            print("  " + postgame_summary(res.postgame) if res.postgame_ts else "  no post-game screen (dodge or game not finished in VOD)")


def process_job(app: AppClient, db: ChampionDB, job: dict, auto_accept: bool, every: float) -> None:
    vod_id = job["id"]
    log.info("VOD %s: %s (%s)", vod_id, job.get("title"), job["url"])
    try:
        streams = video.resolve(job["url"])
    except Exception as e:  # sub-only, deleted, region-locked…
        log.warning("  cannot open VOD: %s", e)
        app.finish_job(vod_id, "failed", error=str(e)[:500])
        return

    scan = S.find_episodes(streams, every)
    log.info("  %d champion select(s), %d post-game screen(s) found", len(scan.drafts), len(scan.postgames))
    found = 0
    for ep in scan.drafts:
        res = S.read_episode(streams, ep, db, scan)
        if not res or res.reading.picks_found < 6:
            log.info("  %s: no full draft (dodge or unreadable), skipped", S.fmt(ep.end))
            continue
        auto = auto_accept and res.reading.picks_confident
        payload = res.reading.to_payload()
        if res.postgame:
            payload["postgame"] = {**res.postgame, "ts_s": int(res.postgame_ts or 0)}
        r = app.upload_frame(
            vod_id, res.ts, res.client_jpeg, res.width, res.height, payload, res.reading.confidence, auto,
            postgame_jpeg=res.postgame_jpeg,
        )
        found += 1
        state = "saved" if r.get("match_id") else f"for review ({r.get('reason')})"
        log.info("  %s: %s → %s", S.fmt(res.ts), summary(res.reading), state)
        if res.postgame:
            log.info("  %s", postgame_summary(res.postgame))
    app.finish_job(vod_id, "done" if found else "skipped", drafts_found=found)


def cmd_run(_args) -> None:
    app = AppClient(env("APP_URL"), env("READER_TOKEN"))
    every = float(env("SAMPLE_SECONDS", "5"))
    poll = float(env("POLL_SECONDS", "300"))
    auto_accept = env("AUTO_ACCEPT", "true").lower() in ("1", "true", "yes")
    db = load_champions()
    log.info("Reader started, polling %s every %ds", env("APP_URL"), poll)
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
        except KeyboardInterrupt:
            break
        except Exception:
            log.exception("Polling failed; retrying in %ds", poll)
            time.sleep(poll)


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="reader", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("run")
    t = sub.add_parser("test")
    t.add_argument("url")
    t.add_argument("at", help="time of the finished draft in the VOD, e.g. 27:00 or 1:27:00")
    t.add_argument("--postgame", help="time of the post-game scoreboard, e.g. 1:00:00")
    sc = sub.add_parser("scan")
    sc.add_argument("url")
    sc.add_argument("--start")
    sc.add_argument("--end")
    args = p.parse_args()
    {"test": cmd_test, "scan": cmd_scan}.get(args.cmd, cmd_run)(args)


if __name__ == "__main__":
    main()
