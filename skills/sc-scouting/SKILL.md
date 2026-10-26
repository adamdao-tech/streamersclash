---
name: sc-scouting
description: Scouting for the Streamers Clash LoL tournament through the SC Scouting connector (sc.daotech.dev) – review drafts read from VODs, build scouting reports on opponent teams and players, add teams/players, check the reader.
---

# SC Scouting

SC Scouting (https://sc.daotech.dev, shown in the app as **SGooBovo šedl scouting**) is Dao's scouting tool for **Streamers Clash**, a Czech League of Legends tournament for streamers. Dao is the coach/manager of SGooB's team. The app tracks teams (ours has `is_own_team = 1`), players (Riot ID, Twitch/Kick channel), their stream VODs, and games read from those VODs by an automatic draft reader.

Always answer Dao in **Czech**. Use the connector tools for every fact about teams, players and games; never invent champions, results or stats. If the connector tools aren't available, say so and ask Dao to enable the SC Scouting connector.

## How the data works

- **POV drafts.** Every game is seen from one streamer's stream. `ally` = the streamer's team (left column of the client), `enemy` = the opponents (right column). Blue/red side isn't known.
- **Result** (`WIN`/`LOSS`) is stored from the ally side. For a player on the enemy side, the result is the opposite – `get_player` already converts this.
- **Lanes.** After a played-out game the post-game scoreboard gives roles in order top, jungle, mid, ADC, support, so `lane` 0–4 is the same for lane opponents. Without a post-game screen, lanes and K/D/A are missing.
- **Sources.** `sync` = saved automatically by the reader, `claude` = saved by you, `user` = entered by hand.
- **Player linking.** Names read by OCR are matched to players by nickname or Riot game name, tolerating 1–2 wrong letters. A player with no games usually has no Riot ID filled in – suggest Dao adds it.
- **Bans** are often missing: the reader saves only bans it is sure about.

## Workflow 1 – reviewing drafts ("zpracuj drafty", "projdi frontu")

1. `list_drafts_for_review` – shows how many frames wait and the reader's guess for each.
2. For each frame: `get_draft_frame`. The first image is champ select; a second image, if present, is the post-game scoreboard.
3. Check the image yourself, don't just trust the guess:
   - Picks: left column top to bottom = `ally`, right column = `enemy`. Under each ally champion is the player name, above it the role.
   - Bans: small icons top-left (ally) and top-right (enemy). Leave them out if you can't tell.
   - If a slot still says "Picking…"/"Banning…", or it's a lobby/loading screen, it's not a finished draft → `discard_draft_frame` with a short reason.
   - Post-game image: VICTORY = `WIN`, DEFEAT = `LOSS` (from the streamer's side). Rows are in role order; take player names and K/D/A from there and set `lane` 0–4 by row.
4. `save_draft` with `frame_id` (VOD and time are taken from the frame). If the reader already read the post-game screen and you don't pass `postgame`, its data is kept.
5. Finish with a short summary: how many saved, how many discarded and why, anything that looked wrong.

If `save_draft` says a champion is unknown, fix the spelling (e.g. "Kai'Sa", "Nunu & Willump", "Wukong") and retry.

## Workflow 2 – scouting report on a team ("scoutni tým X", "na co si dát pozor proti X")

1. `list_teams` (or `search`) to find the team, then `get_team`.
2. `get_player` for every player on the roster – stats, champion pool with winrate and KDA, recent games with lane opponents.
3. Also get our own team (`is_own_team = 1`) when the report is for an upcoming match, to compare lanes.
4. Write the report in Czech:
   - **Shrnutí týmu** – overall record, game types the data comes from (customs vs normals), how much data there is.
   - **Hráč po hráči** – role, most played champions (games, W–L, winrate, KDA), comfort picks, how they did in lane, anything notable from notes.
   - **Návrh banů** – champions with many games and a good winrate on their side; explain why.
   - **Draft a lajny** – likely picks per role, matchups against our players.
   - **Na co si dát pozor** – a few concrete points.
5. Say how big the sample is. With fewer than ~5 games for a player, treat conclusions as tentative. Never fill gaps with general LoL knowledge presented as their data – label general advice as such.
6. Offer to save the key points with `add_scouting_note` (on the team or individual players). Save only when Dao agrees.

## Workflow 3 – adding teams and players

- `add_team` (name, tag; `is_own_team` only for Dao's team).
- `add_player` with role, Riot ID (`GameName#TAG`) and Twitch/Kick channel – a channel name or full link both work. Twitch VODs are fetched right away.
- Remind Dao that Riot ID matters: games are matched to players by it.

## Workflow 4 – schedule ("kdy hrajeme", "další zápas", "přidej scrim")

- The schedule holds three kinds of events: `match` (tournament match), `scrim` (practice games vs another team) and `other` (training, VOD review, meeting – has a `title` instead of an opponent).
- `get_schedule` – our upcoming events (soonest first) and recent results, times in Prague time; `kind` filters one type. The opponent's `opponent_team_id` is the team to scout – that works for scrims too.
- "Kdy hrajeme / proti komu?" → answer from `get_schedule`, then offer a scouting report on the next opponent (Workflow 2).
- `add_scheduled_match` – `kind` (default `match`), `starts_at` as "YYYY-MM-DD HH:MM" Prague time; prefer `opponent_team_id` (find it with `list_teams`/`search`), use `opponent_name` only if the team isn't in the app. Confirm the details with Dao before adding.
- `update_scheduled_match` – move a match or fill in the result (`our_score`, `their_score`). Ask first.
- Deleting is done by Dao on the *Harmonogram* page (list or calendar view).

## Workflow 5 – coaching ("runy pro supporta", "zapiš to do koučingu")

- Coaching lives per player of our team, or team-wide. Dao sorts it into folders he names himself (e.g. "Supp – tank", "Supp – heal"). Each place holds **rune pages**, **notes (zápisky)**, **ward maps** (wards, control wards, farsight, sweeper zones and numbered notes drawn on the minimap) and **screenshots**.
- `get_coaching_screenshot` shows one screenshot (id from `get_coaching`) so you can comment on it – e.g. positioning in a teamfight.
- Ward maps are drawn by Dao in the app; through the connector you only see their title, side, notes and marker counts/labels, not the positions – don't describe where wards are beyond that.
- `get_coaching` (optionally `player_id`) – folders, rune pages (rune names, shards, summoners) and notes.
- `save_rune_page` – runes, paths, shards and summoners by English name; `perks` = keystone, 3 primary, 2 secondary from two different rows. Pass `id` to change an existing page. Ask before saving.
- `add_coaching_note` – a note in Czech for a player, a folder or the whole team; `id` updates an existing one. Good after a scouting report or a scrim review. Ask before saving.
- `add_coaching_folder` – a new folder for a player or the team, when Dao wants one.

## Workflow 6 – checking that things run ("co je nového", "jede čtečka?")

- `get_activity` – recent changes: new VODs (`Sync`), games saved by the reader, frames sent for review, Claude's changes.
- `list_vods` – `scan_status`: `pending` waits for the reader, `scanning` is in progress (a claim expires after 6 h), `done` read, `skipped` no draft found, `failed` couldn't be read (often a sub-only or deleted VOD).
- `rescan_vod` re-queues a VOD; a rescan updates existing games instead of duplicating them.
- If nothing new appears for a long time, the reader on Dao's PC is probably not running: `docker compose up -d` in `~/streamersclash/reader` (WSL), logs with `docker compose logs -f reader`.

## Tools

| Tool | Use |
|---|---|
| `list_teams`, `get_team`, `search` | find teams/players |
| `get_player` | stats, champion pool, games with lane opponents |
| `list_drafts` | saved games for a team, player or VOD |
| `list_vods` | VODs and their reader status |
| `list_drafts_for_review`, `get_draft_frame` | the review queue and its screenshots |
| `save_draft`, `discard_draft_frame` | resolve a review frame |
| `add_scouting_note` | note on a team, player or game (ask first) |
| `add_team`, `add_player` | new data |
| `rescan_vod`, `get_activity` | reader and app status |
| `get_schedule`, `add_scheduled_match`, `update_scheduled_match` | our match schedule |
| `get_coaching`, `get_coaching_screenshot`, `save_rune_page`, `add_coaching_note`, `add_coaching_folder` | coaching: rune pages and notes per player/folder |
