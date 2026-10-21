# Streamers Clash – Scouting Hub

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

## Roadmap
1. ~~DB schema, Twitch login, teams & players~~
2. Twitch/Kick VOD sync, live status
3. Remote MCP connector (OAuth) for Claude
4. Riot API sync, draft editor, champion pools, compare view
