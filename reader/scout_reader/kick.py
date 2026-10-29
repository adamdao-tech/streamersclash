"""Kick VODs.

Kick has no public VOD API, and its internal API (kick.com/api/v2) sits behind Cloudflare, which
blocks plain HTTP clients and requests from Cloudflare Workers. The reader runs on a home connection
and uses curl_cffi with a browser fingerprint, so it fetches the channels' VODs and hands them to the app.
Each VOD comes with a direct HLS playlist (`source`), which ffmpeg reads like any other stream.
"""

from __future__ import annotations

import logging
import re
import time
from urllib.parse import urljoin

from curl_cffi import requests as creq

log = logging.getLogger(__name__)

API = "https://kick.com/api/v2"
VIDEOS_PER_CHANNEL = 10
_IMPERSONATE = "chrome"


def _get(url: str, **kw):
    r = creq.get(url, impersonate=_IMPERSONATE, timeout=30, **kw)
    if r.status_code == 404:
        raise LookupError("Kick kanál neexistuje")
    if r.status_code in (403, 429):
        raise RuntimeError(f"Kick zablokoval požadavek (HTTP {r.status_code})")
    r.raise_for_status()
    return r


def _iso(ts: str | None) -> str | None:
    """'2026-10-23 16:44:50' (UTC) → '2026-10-23T16:44:50Z'"""
    if not ts:
        return None
    ts = ts.strip().replace(" ", "T")
    ts = re.sub(r"\.\d+", "", ts)
    return ts if ts.endswith("Z") or re.search(r"[+-]\d\d:?\d\d$", ts) else ts + "Z"


def channel_vods(slug: str) -> list[dict]:
    """Finished VODs of a channel in the app's format (a stream still running is left for later)."""
    items = _get(f"{API}/channels/{slug}/videos").json()
    out = []
    for v in items if isinstance(items, list) else []:
        video = v.get("video") or {}
        uuid = video.get("uuid")
        if not uuid or v.get("is_live") or video.get("is_private") or video.get("deleted_at"):
            continue
        thumb = (v.get("thumbnail") or {}).get("src")
        out.append({
            "external_id": uuid,
            "url": f"https://kick.com/{slug}/videos/{uuid}",
            "stream_url": v.get("source"),
            "title": v.get("session_title"),
            "started_at": _iso(v.get("start_time") or v.get("created_at")),
            "duration_s": int((v.get("duration") or 0) / 1000) or None,
            "thumbnail_url": thumb,
        })
        if len(out) >= VIDEOS_PER_CHANNEL:
            break
    return out


def sync(app) -> tuple[int, int]:
    """Sends every Kick channel's VODs to the app. Returns (channels synced, new VODs)."""
    channels = app.kick_channels()
    synced = added = 0
    for ch in channels:
        slug = ch["slug"]
        try:
            vods = channel_vods(slug)
            r = app.post_kick_vods(slug, vods)
            synced += 1
            added += r.get("added", 0)
            if r.get("added"):
                log.info("Kick %s: %d new VOD(s)", slug, r["added"])
        except Exception as e:  # one bad channel mustn't stop the rest
            log.warning("Kick %s: %s", slug, e)
            try:
                app.post_kick_vods(slug, error=str(e)[:300])
            except Exception:
                log.exception("  could not report the error to the app")
        time.sleep(2)  # be gentle with Kick
    return synced, added


# --- playing a Kick VOD -----------------------------------------------------------

_STREAM_INF = re.compile(r"#EXT-X-STREAM-INF:([^\n]*)\n([^\n#][^\n]*)")


def variants(master_url: str) -> list[dict]:
    """Renditions listed in an HLS master playlist: [{height, bandwidth, url}], lowest first."""
    text = _get(master_url).text
    out = []
    for attrs, uri in _STREAM_INF.findall(text):
        res = re.search(r"RESOLUTION=\d+x(\d+)", attrs)
        bw = re.search(r"BANDWIDTH=(\d+)", attrs)
        out.append({"height": int(res.group(1)) if res else 0, "bandwidth": int(bw.group(1)) if bw else 0, "url": urljoin(master_url, uri.strip())})
    if not out:  # already a media playlist
        out.append({"height": 0, "bandwidth": 0, "url": master_url})
    return sorted(out, key=lambda v: (v["height"], v["bandwidth"]))


def is_kick(url: str | None) -> bool:
    return bool(url) and "kick.com" in url


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def source_for(url: str) -> str | None:
    """HLS playlist of a Kick VOD link (kick.com/<channel>/videos/<uuid>, the uuid the app stores)."""
    m = _UUID.search(url or "")
    if not m:
        return None
    try:
        return _get(f"https://kick.com/api/v1/video/{m.group(0)}").json().get("source")
    except Exception as e:
        log.warning("Kick VOD %s: %s", m.group(0), e)
        return None
