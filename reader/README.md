# Draft reader

Runs on your PC (Docker in WSL2). It asks the app for finished VODs, scans each one at low quality for the League client's champion select, grabs a sharp frame of the finished draft and reads it:

- champion names → OCR (Tesseract) + fuzzy match against Riot's champion list
- bans → matched against Riot's champion icons

Confident reads are saved straight away. Anything unsure is uploaded as a frame for review, which Claude goes through via the MCP connector.

## Setup

1. Generate a token: `openssl rand -hex 32`
2. In Cloudflare (Worker → Settings → Variables and Secrets) add a **secret** `READER_TOKEN` with that value.
3. Here: `cp .env.example .env` and put the same value into `READER_TOKEN`.
4. `docker compose up -d --build`

Logs: `docker compose logs -f reader`

## Trying it on one VOD

Read the draft at a given moment (writes debug images to `./debug`):

```bash
docker compose run --rm reader test https://www.twitch.tv/videos/2906053508 27:00
```

Find and read all champion selects in part of a VOD, without uploading anything:

```bash
docker compose run --rm reader scan https://www.twitch.tv/videos/2906053508 --start 15:00 --end 45:00
```

## How detection works

`scout_reader/reference/champselect.png` is a champ select screenshot with everything blacked out except UI parts that never change (chat box, QUIT button, dividers). Every sampled frame is compared against it at many sizes, so the client can be anywhere in the stream layout. Layout coordinates (rows, ban icons) are in `scout_reader/layout.py`.
