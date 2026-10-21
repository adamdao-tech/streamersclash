# Project: LoL Scouting Hub (Streamers Clash)

Build a web application for scouting League of Legends teams and players for the Czech streamer tournament **Streamers Clash**. I'm the coach/manager of one team, and I want to prepare for opponents: their drafts, champion pools, matchups, and stream VODs. The app must also hold **our own team**, so we can review ourselves the same way.

## Core concepts / data model
- **Team**: name, tag, logo, is_own_team flag, notes, list of players, season/tournament.
- **Player**: nickname, role (Top/Jungle/Mid/ADC/Support/Sub), Riot ID (gameName#tagLine) + region (default EUNE, allow EUW), Twitch channel, Kick channel, notes, tags (e.g. "comfort picks", "tilts easily").
- **Match**: date, teams, result, source (Riot API / manual / VOD), link to VOD + timestamp.
- **Draft**: per match: blue/red side, bans in order, picks in order (pick phase 1/2), who played which champion and role, result.
- **Champion stats** (derived): per player and per team: games, win rate, KDA, last played, and against whom (lane opponent champion + player).
- **VOD**: platform (Twitch / Kick / vodvod.tv), URL, date, title, duration, linked player/match, optional timestamps of games.
- **Scouting note**: free text + author (me or "Claude"), linked to a team/player/match.

## Data sources
1. **Riot API** (Account-V1 for PUUID, Match-V5, data from Data Dragon for champion names/icons): pull recent ranked/normal games for each player, store champion, role, result, KDA, and lane opponent. Respect rate limits (queue + caching). API key in env secret.
   - Note: tournament/custom games are usually NOT available via Match-V5, so **tournament drafts must be enterable manually** (fast draft editor, see UI) or added by Claude via MCP.
2. **Twitch** (Helix API: users, videos type=archive) and **Kick** (public API/channel endpoints) → list a player's recent VODs and whether they're live.
3. **vodvod.tv**: optional adapter that searches a streamer's archived VODs there. Implement it as a separate, swappable provider module; first check whether the site has an API or stable URLs, respect its robots.txt/ToS, rate-limit requests, and if it can't be used reliably, fall back to storing manually pasted links.
- Put all providers behind a common interface (`VodProvider`, `MatchProvider`) so sources can be added/removed.

## MCP connector (important)
Expose a **remote MCP server** (Streamable HTTP, auth via bearer token / OAuth) so I can connect Claude and have it periodically check and update the data. Tools:
- `list_teams`, `get_team(id)`, `get_player(id)`, `search(query)`
- `add_team`, `add_player`, `update_player`
- `refresh_player_matches(player_id)` – triggers Riot sync
- `list_new_vods(since)` – new VODs across all tracked players
- `add_match_with_draft(...)` – Claude can enter a draft it read from a VOD/screenshot
- `add_scouting_note(target, text)`
- `get_team_report(team_id)` – a structured summary: champion pools, most banned/picked, first-pick tendencies, side preference, weak spots
- Every write made via MCP is logged (activity feed) and marked as "added by Claude" so I can review/undo it.

Also add a scheduled job (Cron Trigger) that syncs Riot matches and VODs e.g. every 6 hours, so Claude mostly reads fresh data.

## UI / UX
Make it **visually polished**, esports-broadcast vibe: dark theme, champion icons from Data Dragon, team logos, role icons, accent colors per team.
- **Dashboard**: upcoming opponents, newest VODs, live streamers, recent activity (incl. Claude's).
- **Team page**: roster cards, team champion pool heatmap (player × champion), draft history with visual pick/ban rows, side win rates, "Scouting report" panel.
- **Player page**: champion pool with win rate/games/last played, matchup table (vs which champions/players), recent games, VOD list with embedded player, notes.
- **Draft editor**: fast click-to-pick champion grid with search, drag to reorder, for manual tournament draft entry.
- **Compare view**: our team vs opponent — overlapping champion pools, likely bans, suggested target bans.
- Global search, filters (role, champion, date range, patch).
- Responsive (works on phone during the event), Czech + English UI strings.

## Tech stack
- Cloudflare: Workers (API + MCP server), D1 (SQLite) database, Pages/Workers static assets for the frontend, Cron Triggers, KV for API caching.
- Frontend: React + TypeScript + Vite + Tailwind; charts with a lightweight library (e.g. Recharts).
- Simple auth for the web UI (only me and my team; invite by email or shared password), separate token for MCP.
- Secrets via `wrangler secret` (RIOT_API_KEY, TWITCH_CLIENT_ID/SECRET, MCP_TOKEN).
- Repo on GitHub (adamdao-tech/streamersclash), deploy to a subdomain like `scout.daotech.dev`.

> Alternative backend: the app may instead use **Base44** as the data/auth backend — see [`docs/base44.md`](docs/base44.md). If so, keep the same entities and MCP tools, but implement them on top of the Base44 SDK instead of D1.

## Delivery plan
1. Data model + migrations + seed with a demo team.
2. CRUD for teams/players + Riot sync for one player end-to-end.
3. Team & player pages with champion pools and draft visuals.
4. Twitch/Kick VODs, then the vodvod.tv adapter.
5. MCP server + cron sync + activity log.
6. Polish UI, compare view, deploy.

Before writing code, show me the proposed schema and folder structure, and tell me which of the data sources need API keys or registration on my side.
