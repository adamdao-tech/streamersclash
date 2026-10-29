"""Client for the scouting app's reader API (src/reader.ts)."""

from __future__ import annotations

import base64

import requests


class AppClient:
    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"

    def _check(self, r: requests.Response) -> dict:
        if r.status_code == 401:
            raise RuntimeError("App rejected READER_TOKEN (401). Is it set the same in Cloudflare and in .env?")
        if not r.ok:
            try:
                msg = r.json().get("message") or r.text
            except ValueError:
                msg = r.text
            raise RuntimeError(f"App error {r.status_code}: {msg}")
        return r.json()

    def claim_jobs(self, limit: int = 1) -> list[dict]:
        return self._check(self.s.get(f"{self.base}/api/reader/jobs", params={"limit": limit}, timeout=30))["jobs"]

    def kick_channels(self) -> list[dict]:
        return self._check(self.s.get(f"{self.base}/api/reader/kick/channels", timeout=30))["channels"]

    def post_kick_vods(self, slug: str, vods: list[dict] | None = None, error: str | None = None) -> dict:
        return self._check(
            self.s.post(f"{self.base}/api/reader/kick/vods", json={"slug": slug, "vods": vods or [], "error": error}, timeout=60)
        )

    def finish_job(self, vod_id: int, status: str, drafts_found: int = 0, error: str | None = None) -> None:
        self._check(
            self.s.post(
                f"{self.base}/api/reader/jobs/{vod_id}",
                json={"status": status, "drafts_found": drafts_found, "error": error},
                timeout=30,
            )
        )

    def upload_frame(
        self, vod_id: int | None, ts: float, jpeg: bytes, width: int, height: int, reading: dict, confidence: float, auto: bool,
        postgame_jpeg: bytes | None = None, vod_url: str | None = None,
    ) -> dict:
        return self._check(
            self.s.post(
                f"{self.base}/api/reader/frames",
                json={
                    "vod_id": vod_id,
                    "vod_url": vod_url,
                    "ts_s": int(ts),
                    "image_b64": base64.b64encode(jpeg).decode(),
                    "width": width,
                    "height": height,
                    "reading": reading,
                    "confidence": confidence,
                    "auto": auto,
                    "postgame_image_b64": base64.b64encode(postgame_jpeg).decode() if postgame_jpeg else None,
                },
                timeout=60,
            )
        )
