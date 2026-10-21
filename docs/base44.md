# Base44 backend notes

The app has a Base44 backend (app ID below). The SDK handles authentication and provides typed methods for all entity operations and backend functions.

## Install

```bash
npm install @base44/sdk
```

## Client

The personal access token is a secret: never commit it. Load it from an environment variable (e.g. `.env`, which is git-ignored, or a `wrangler secret`).

```js
import { createClient } from '@base44/sdk';

const base44 = createClient({
  appId: "6ad88ba22c97308d1f012391",
  headers: {
    Authorization: `Bearer ${process.env.BASE44_TOKEN}`,
  },
});
```

Requests fail until a valid personal access token is set.

## Entity: `Team`

| Field | Type | Notes |
|---|---|---|
| `name` * | string | required |
| `tag` | string | |
| `logo_url` | string | |
| `is_own_team` | boolean | our team vs. opponent |
| `accent_color` | string | |
| `tournament` | string | |
| `region` | string (`EUNE` \| `EUW`) | |
| `coach` | string | |
| `notes` | string | |
| `id` | string | unique record identifier (system) |
| `created_date` | string (date-time) | system |
| `updated_date` | string (date-time) | system |
| `created_by_id` | string | ID of the user who created the record (system) |

### Endpoints

| Method | Path | Action |
|---|---|---|
| GET | `/entities/Team` | List Team records |
| POST | `/entities/Team` | Create a Team record |
| DELETE | `/entities/Team` | Delete multiple Team records |
| POST | `/entities/Team/bulk` | Bulk create Team records |
| PUT | `/entities/Team/bulk` | Bulk update Team records |
| PATCH | `/entities/Team/update-many` | Update many Team records by query |
| GET | `/entities/Team/{Team_id}` | Get a Team record by ID |
| PUT | `/entities/Team/{Team_id}` | Update a Team record |
| DELETE | `/entities/Team/{Team_id}` | Delete a Team record |
| POST | `/entities/Team/{Team_id}/restore` | Restore a deleted Team record |

> HTTP methods are inferred from the Base44 docs listing (which showed only paths) — verify against the Base44 API reference.

## TODO
- Add schemas for the remaining entities: Player, Match, Draft, VOD, ScoutingNote.
