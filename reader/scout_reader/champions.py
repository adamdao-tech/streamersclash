"""Champion names and square icons from Riot's Data Dragon, cached on disk."""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import requests

log = logging.getLogger(__name__)
DDRAGON = "https://ddragon.leagueoflegends.com"


@dataclass(frozen=True)
class Champion:
    id: str  # Data Dragon id, e.g. "MonkeyKing"
    name: str  # display name, e.g. "Wukong"
    key: str  # letters only, upper case, for matching OCR output, e.g. "WUKONG"


def letters(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^A-Z]", "", s.upper())


class ChampionDB:
    def __init__(self, champions: list[Champion], icon_dir: Path | None = None):
        self.champions = champions
        self.icon_dir = icon_dir
        self._icons: dict[str, np.ndarray] | None = None

    @classmethod
    def load(cls, cache_dir: Path, offline_file: Path | None = None) -> "ChampionDB":
        """Latest champion list from Data Dragon (cached), or a local JSON list when offline."""
        cache_dir.mkdir(parents=True, exist_ok=True)
        if offline_file:
            names = json.loads(offline_file.read_text())
            return cls([Champion(n.replace(" ", ""), n, letters(n)) for n in names])

        version = requests.get(f"{DDRAGON}/api/versions.json", timeout=20).json()[0]
        list_file = cache_dir / f"champions-{version}.json"
        if not list_file.exists():
            data = requests.get(f"{DDRAGON}/cdn/{version}/data/en_US/champion.json", timeout=30).json()["data"]
            list_file.write_text(json.dumps([{"id": c["id"], "name": c["name"]} for c in data.values()]))
            log.info("Downloaded champion list for patch %s", version)
        raw = json.loads(list_file.read_text())
        champions = [Champion(c["id"], c["name"], letters(c["name"])) for c in raw]

        icon_dir = cache_dir / f"icons-{version}"
        if not icon_dir.exists() or len(list(icon_dir.glob("*.png"))) < len(champions):
            icon_dir.mkdir(exist_ok=True)
            for c in champions:
                f = icon_dir / f"{c.id}.png"
                if not f.exists():
                    r = requests.get(f"{DDRAGON}/cdn/{version}/img/champion/{c.id}.png", timeout=30)
                    if r.ok:
                        f.write_bytes(r.content)
            log.info("Downloaded champion icons for patch %s", version)
        return cls(champions, icon_dir)

    def by_id(self, champ_id: str) -> Champion | None:
        return next((c for c in self.champions if c.id == champ_id), None)

    def icons(self) -> dict[str, np.ndarray]:
        if self._icons is None:
            self._icons = {}
            if self.icon_dir:
                for c in self.champions:
                    img = cv2.imread(str(self.icon_dir / f"{c.id}.png"))
                    if img is not None:
                        self._icons[c.id] = img
        return self._icons
