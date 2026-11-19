# Twitch panel – harmonogram (SC Scouting)

Panelové rozšíření pro Twitch: pod streamem ukazuje turnajové zápasy našeho týmu živě z `https://sc.daotech.dev/rozpis.json`.

Nastavení v https://dev.twitch.tv/console/extensions (Create Extension → Panel):
- **Asset Hosting**: Panel Viewer Path `panel.html`, Panel Height `400`
- **Capabilities → Allowlist for URL Fetching Domains**: `https://sc.daotech.dev`
- **Capabilities → Allowlist for Panel URLs**: `https://sc.daotech.dev/rozpis`
- Files: nahraj ZIP obsahu této složky (soubory v kořeni ZIPu, ne ve složce).

Postup: Local Test → Hosted Test (vidí jen účty z Testing Account Allowlist) → Submit for Review → Release (pak ho vidí všichni diváci).
