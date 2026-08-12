# Music catalog seeds

Curated private music library (metadata first; acquisition later).

## Targets

| | |
|---|---|
| Tracks | up to **100 000** (relevance-first — quality over fill) |
| Quality | **320 kbps** (encode target when acquired) |
| Brazilian share | **~33%** |
| Est. storage @ 320 kbps | **~400–800 GB** depending on dedupe |

## Curation rules

| Origin | What we keep |
|---|---|
| **Brazilian** | Deep + **regional OK**. Top tracks + popular albums. Related expansion allowed. |
| **International** | **Global relevance** (strict fans + Deezer rank). Distinct versions kept. |

## On-disk layout (sharded — GitHub-safe)

**Never commit monoliths** (`music_catalog.json` / `.raw.json` exceed GitHub’s 100MB limit).

```
backend/data/music/
  catalog/                 # ← tracked (live, deduped)
    index.json             # metadata + shard manifest
    tracks-000.json        # compact { items: [...] }  (~12k tracks/shard)
    tracks-001.json
    ...
    playlists.json         # { playlists: [...] }  (track_id refs only)
  raw/                     # ← gitignored (crawl working set)
    index.json
    tracks-*.json
data/music/
  seed-artists.json        # curated seeds
  generate-progress.json   # resume state
```

| Field | Role |
|---|---|
| `items[]` (sharded) | **Canonical tracks** — one row per *song+version* |
| `playlists[]` | Albums / compilations / “mais tocadas” — **`track_ids` only** |

**Dedupe:** unify same song on many compilations; **keep** studio vs ao vivo / remix / acústico.

```bash
# continue fetch
npm run catalog:music:resume

# dedupe raw → catalog shards
npm run catalog:music:dedupe

# one-shot migrate legacy monolith → shards
npm run catalog:music:split
```

Load in code:

```js
import { loadMusicCatalog } from "./lib/music-catalog-store.mjs";
const { metadata, items, playlists } = loadMusicCatalog();
```
