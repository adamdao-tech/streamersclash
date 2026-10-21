// Database migrations. Applied automatically on the first request handled by
// each Worker instance (see ensureSchema in db.ts). Append new migrations to the
// end of the list; never edit one that has already been deployed.
//
// Statements are separated by ";" at line end, so don't put ";" inside string literals.

export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_login  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  twitch_id     TEXT UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE teams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  tag          TEXT,
  logo_url     TEXT,
  accent_color TEXT,
  is_own_team  INTEGER NOT NULL DEFAULT 0,
  tournament   TEXT,
  region       TEXT NOT NULL DEFAULT 'EUNE' CHECK (region IN ('EUNE', 'EUW')),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE players (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  nickname       TEXT NOT NULL,
  role           TEXT CHECK (role IN ('TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT', 'SUB')),
  riot_game_name TEXT,
  riot_tag_line  TEXT,
  riot_puuid     TEXT,
  region         TEXT NOT NULL DEFAULT 'EUNE' CHECK (region IN ('EUNE', 'EUW')),
  twitch_login   TEXT,
  kick_slug      TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_players_team ON players(team_id);

CREATE TABLE vods (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER REFERENCES players(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('twitch', 'kick', 'vodvod', 'other')),
  external_id   TEXT,
  url           TEXT NOT NULL,
  title         TEXT,
  started_at    TEXT,
  duration_s    INTEGER,
  thumbnail_url TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (platform, external_id)
);
CREATE INDEX idx_vods_player ON vods(player_id, started_at);

CREATE TABLE matches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  played_at       TEXT,
  blue_team_id    INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  red_team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  winner_side     TEXT CHECK (winner_side IN ('BLUE', 'RED')),
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('riot', 'manual', 'vod')),
  riot_match_id   TEXT UNIQUE,
  vod_id          INTEGER REFERENCES vods(id) ON DELETE SET NULL,
  vod_timestamp_s INTEGER,
  patch           TEXT,
  notes           TEXT,
  created_by_kind TEXT NOT NULL DEFAULT 'user' CHECK (created_by_kind IN ('user', 'claude', 'sync')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE draft_actions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  side      TEXT NOT NULL CHECK (side IN ('BLUE', 'RED')),
  action    TEXT NOT NULL CHECK (action IN ('BAN', 'PICK')),
  champion  TEXT NOT NULL,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  role      TEXT,
  UNIQUE (match_id, seq)
);

CREATE TABLE player_games (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  riot_match_id     TEXT NOT NULL,
  played_at         TEXT,
  queue_id          INTEGER,
  champion          TEXT NOT NULL,
  role              TEXT,
  win               INTEGER,
  kills             INTEGER,
  deaths            INTEGER,
  assists           INTEGER,
  opponent_champion TEXT,
  opponent_name     TEXT,
  patch             TEXT,
  UNIQUE (player_id, riot_match_id)
);
CREATE INDEX idx_player_games_player ON player_games(player_id, played_at);

CREATE TABLE notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type    TEXT NOT NULL CHECK (target_type IN ('team', 'player', 'match')),
  target_id      INTEGER NOT NULL,
  body           TEXT NOT NULL,
  author_kind    TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'claude')),
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notes_target ON notes(target_type, target_id);

CREATE TABLE activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user', 'claude', 'sync')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  details       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_created ON activity_log(created_at);
`,

  /* 2: VOD sync */ `
CREATE TABLE kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT NOT NULL CHECK (platform IN ('twitch', 'kick')),
  login      TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (platform, login)
);

CREATE TABLE sync_state (
  key            TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_error     TEXT
);

ALTER TABLE vods ADD COLUMN channel_login TEXT;
ALTER TABLE vods ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'scanning', 'done', 'skipped', 'failed'));
ALTER TABLE vods ADD COLUMN scanned_at TEXT;
CREATE INDEX idx_vods_channel ON vods(platform, channel_login, started_at);
CREATE INDEX idx_vods_scan ON vods(scan_status, started_at);
`,
];
