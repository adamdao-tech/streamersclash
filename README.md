# SGooBovo šedl scouting (Streamers Clash – Scouting Hub)

Web app for scouting League of Legends teams and players in Streamers Clash: drafts, champion pools, matchups, Twitch/Kick/vodvod.tv VODs, and an MCP connector so Claude can keep the data up to date.

Live: https://sc.daotech.dev

- [`PROMPT.md`](PROMPT.md) – the full build brief

## Stack
Cloudflare Worker (`src/`) + static pages (`public/`) + D1 database. The schema migrates itself on the first request (`src/schema.ts`).

## Login
Twitch OAuth. Only users on the allowlist can log in. The **first person who logs in becomes admin**; admins add others on the *Uživatelé* page by Twitch login.

## Setup
1. Twitch app at https://dev.twitch.tv/console with redirect URL `https://sc.daotech.dev/auth/callback` (and `http://localhost:8787/auth/callback` for local dev). The Client ID is in `wrangler.jsonc`.
2. Secret `TWITCH_CLIENT_SECRET` in Cloudflare: Worker → Settings → Variables and Secrets.
3. Local dev: `npm install`, copy `.dev.vars.example` to `.dev.vars`, `npm run dev`.

## MCP connector (Claude)
In claude.ai: Settings → Connectors → Add custom connector, URL `https://sc.daotech.dev/mcp`.
Claude logs in through the normal Twitch login and a consent page; its changes show up in the activity log as "Claude".

## Claude skill
[`skills/sc-scouting/SKILL.md`](skills/sc-scouting/SKILL.md) teaches Claude how to use the connector: reviewing drafts, scouting reports, adding players, checking the reader.

## Draft reader
See [`reader/README.md`](reader/README.md). Needs the `READER_TOKEN` secret in Cloudflare.

## Roadmap
1. ~~DB schema, Twitch login, teams & players~~
2. ~~Twitch VOD sync, live status~~ (Kick later)
3. ~~Remote MCP connector (OAuth) for Claude~~
4. ~~Draft reader (VOD → champ select → draft)~~, tuning on real VODs
5. ~~Schedule (Harmonogram): tournament matches, scrims and other events, list + calendar view, next-match countdown~~
6. ~~Koučing: folders per player, rune pages (rune picker from Data Dragon), coaching notes, ward maps on the minimap, own uploaded map picture, screenshots (paste/drop)~~
7. Drafts in the web UI, Riot API sync, champion pools, compare view
