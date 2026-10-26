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

  /* 3: draft reader + MCP OAuth */ `
DROP TABLE draft_actions;
CREATE TABLE draft_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('BLUE', 'RED', 'ALLY', 'ENEMY')),
  action      TEXT NOT NULL CHECK (action IN ('BAN', 'PICK')),
  slot        INTEGER,
  champion    TEXT NOT NULL,
  player_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  player_name TEXT,
  role        TEXT,
  UNIQUE (match_id, seq)
);
CREATE INDEX idx_draft_actions_match ON draft_actions(match_id);
CREATE INDEX idx_draft_actions_player ON draft_actions(player_id);

ALTER TABLE matches ADD COLUMN pov_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL;

CREATE TABLE draft_frames (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vod_id      INTEGER NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
  ts_s        INTEGER NOT NULL,
  image       BLOB NOT NULL,
  width       INTEGER,
  height      INTEGER,
  reading     TEXT,
  confidence  REAL,
  status      TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'accepted', 'discarded')),
  match_id    INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vod_id, ts_s)
);
CREATE INDEX idx_draft_frames_status ON draft_frames(status, created_at);

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id  TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id);
`,

  /* 4: game results from the post-game scoreboard */ `
ALTER TABLE matches ADD COLUMN result TEXT CHECK (result IN ('WIN', 'LOSS'));
ALTER TABLE matches ADD COLUMN game_type TEXT;
ALTER TABLE matches ADD COLUMN duration_s INTEGER;
ALTER TABLE matches ADD COLUMN postgame_ts INTEGER;
ALTER TABLE draft_actions ADD COLUMN kills INTEGER;
ALTER TABLE draft_actions ADD COLUMN deaths INTEGER;
ALTER TABLE draft_actions ADD COLUMN assists INTEGER;
ALTER TABLE draft_actions ADD COLUMN lane INTEGER;
ALTER TABLE draft_frames ADD COLUMN postgame_image BLOB;
`,

  /* 5: our match schedule (harmonogram) */ `
CREATE TABLE schedule (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at        TEXT NOT NULL,
  opponent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  opponent_name    TEXT,
  format           TEXT NOT NULL DEFAULT 'BO1' CHECK (format IN ('BO1', 'BO2', 'BO3', 'BO5')),
  stage            TEXT,
  location         TEXT,
  stream_url       TEXT,
  our_score        INTEGER,
  their_score      INTEGER,
  notes            TEXT,
  created_by_kind  TEXT NOT NULL DEFAULT 'user' CHECK (created_by_kind IN ('user', 'claude')),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_schedule_starts ON schedule(starts_at);
`,

  /* 6: schedule event types (tournament match, scrim, other) */ `
ALTER TABLE schedule ADD COLUMN kind TEXT NOT NULL DEFAULT 'match' CHECK (kind IN ('match', 'scrim', 'other'));
ALTER TABLE schedule ADD COLUMN title TEXT;
`,

  /* 7: coaching - folders per player (or team-wide), rune pages, notes */ `
CREATE TABLE coaching_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  INTEGER REFERENCES players(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_coaching_folders_player ON coaching_folders(player_id);

CREATE TABLE coaching_runes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       INTEGER REFERENCES players(id) ON DELETE CASCADE,
  folder_id       INTEGER REFERENCES coaching_folders(id) ON DELETE CASCADE,
  title           TEXT,
  champion        TEXT,
  primary_style   INTEGER,
  secondary_style INTEGER,
  perks           TEXT NOT NULL DEFAULT '[]',
  shards          TEXT NOT NULL DEFAULT '[]',
  summoners       TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  created_by_kind TEXT NOT NULL DEFAULT 'user' CHECK (created_by_kind IN ('user', 'claude')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_coaching_runes_player ON coaching_runes(player_id);
CREATE INDEX idx_coaching_runes_folder ON coaching_runes(folder_id);

CREATE TABLE coaching_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id      INTEGER REFERENCES players(id) ON DELETE CASCADE,
  folder_id      INTEGER REFERENCES coaching_folders(id) ON DELETE CASCADE,
  title          TEXT,
  body           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  author_kind    TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'claude')),
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_coaching_notes_player ON coaching_notes(player_id);
CREATE INDEX idx_coaching_notes_folder ON coaching_notes(folder_id);
`,
];
