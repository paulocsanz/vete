#!/usr/bin/env node
/**
 * Generate a *relevance-first* music catalog (~100k tracks @ 320kbps target).
 *
 * Curation rules:
 *   Brazilian  — deep + regional OK (MPB, samba, sertanejo, forró, funk, axé…).
 *                Prefer popular tracks, but keep solid discography depth.
 *   International — ONLY globally relevant material (artist top tracks + a few
 *                flagship albums). No deep-cut discography dumps, no regional
 *                intl filler via "related" expansion.
 *
 * Usage (from repo root):
 *   node scripts/catalog/generate-music-catalog.mjs
 *   node scripts/catalog/generate-music-catalog.mjs --target 100000 --br-ratio 0.33
 *   node scripts/catalog/generate-music-catalog.mjs --resume
 *
 * Outputs (sharded — never a single 100MB+ file):
 *   backend/data/music/raw/catalog/*     — fetched rows (gitignored)
 *   backend/data/music/catalog/*         — canonical tracks + playlists
 *   data/music/generate-progress.json
 *
 * After each save (and at end) runs version-aware dedupe:
 *   same song+version unified; live/remix/acoustic kept separate; playlists ref ids.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  loadRawCatalog as loadRawFromStore,
  saveRawCatalog as saveRawToStore,
  CATALOG_DIR,
  RAW_DIR,
} from "../../lib/music-catalog-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const SEED_PATH = path.join(ROOT, "data/music/seed-artists.json");
const PROGRESS_PATH = path.join(ROOT, "data/music/generate-progress.json");
const DEDUPE_SCRIPT = path.join(ROOT, "scripts/catalog/dedupe-music-catalog.mjs");

const DEEZER = "https://api.deezer.com";
const UA = "vete-music-catalog/1.0 (private curated library)";

/**
 * Per-origin / tier policy. No per-artist track ceiling — keep every track
 * that clears relevance gates (fans / rank / top-list).
 *
 * Brazilian  — deep + regional OK
 * International — global relevance only (strict rank), but uncapped count
 */
const POLICY = {
  Brazilian: {
    minFans: { 1: 5_000, 2: 2_000, 3: 500 },
    // how many /top tracks to page in (Deezer relevance order)
    topTracks: { 1: 150, 2: 100, 3: 60 },
    // popular albums to walk (by album fans); all qualifying tracks kept
    maxAlbums: { 1: 80, 2: 40, 3: 18 },
    // drop album-sourced tracks below this rank; /top always kept
    minRank: { 1: 5_000, 2: 8_000, 3: 15_000 },
    expandRelated: true,
    relatedLimit: 20,
    relatedTierBump: 1,
  },
  International: {
    // Global fame gate (not regional intl scenes)
    minFans: { 1: 250_000, 2: 100_000, 3: 40_000 },
    topTracks: { 1: 100, 2: 60, 3: 30 },
    // more albums OK — rank filter is what keeps it "global essentials"
    maxAlbums: { 1: 50, 2: 20, 3: 8 },
    minRank: { 1: 80_000, 2: 120_000, 3: 200_000 },
    // related only for mega-global peers (still filtered by fans/rank)
    expandRelated: true,
    relatedLimit: 8,
    relatedTierBump: 1,
  },
};

// Album title noise — especially harmful for "global essentials"
const SKIP_ALBUM_RE =
  /\b(karaoke|tribute|in the style of|musique de|music from the motion|workout|preschool|baby\s*lullaby|8-bit|8 bit|lullaby|yoga|spa\s*music|white noise)\b/i;

function parseArgs(argv) {
  const out = {
    target: 100_000,
    brRatio: 0.33,
    resume: false,
    delayMs: 200,
    // default: follow POLICY (BR yes, intl no)
    expandRelated: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = Number(argv[++i]);
    else if (a === "--br-ratio") out.brRatio = Number(argv[++i]);
    else if (a === "--resume") out.resume = true;
    else if (a === "--delay-ms") out.delayMs = Number(argv[++i]);
    else if (a === "--no-expand") out.expandRelated = false;
    else if (a === "--expand") out.expandRelated = true;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "e")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function policyFor(origin) {
  return POLICY[origin] || POLICY.International;
}

async function deezer(pathname, { delayMs } = {}) {
  const url = pathname.startsWith("http") ? pathname : `${DEEZER}${pathname}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (delayMs) await sleep(delayMs);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      if (attempt < 4) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw new Error(`Deezer ${res.status} ${url}`);
    }
    const json = await res.json();
    if (json?.error) {
      if (json.error.code === 4 || json.error.code === 700) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return json;
    }
    return json;
  }
  throw new Error(`Deezer failed after retries: ${url}`);
}

async function resolveArtist(name, delayMs) {
  const q = encodeURIComponent(name);
  const json = await deezer(`/search/artist?q=${q}&limit=8`, { delayMs });
  const data = json?.data || [];
  if (!data.length) return null;
  const target = normName(name);
  const scored = data.map((a) => {
    const n = normName(a.name);
    let score = a.nb_fan || 0;
    if (n === target) score += 1e12;
    else if (n.includes(target) || target.includes(n)) score += 1e9;
    return { a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored[0].a;
}

/** Paginate Deezer list endpoints (data + next). */
async function fetchPages(firstPath, { delayMs, maxItems = 200 } = {}) {
  const out = [];
  let url = firstPath;
  while (url && out.length < maxItems) {
    const json = await deezer(url, { delayMs });
    if (json?.error || !json?.data) break;
    for (const row of json.data) {
      out.push(row);
      if (out.length >= maxItems) break;
    }
    if (!json.next) break;
    url = json.next.startsWith("http") ? json.next : json.next.replace(DEEZER, "");
  }
  return out;
}

async function fetchTopTracks(artistId, limit, delayMs) {
  return fetchPages(`/artist/${artistId}/top?limit=${Math.min(50, limit)}`, {
    delayMs,
    maxItems: limit,
  });
}

async function fetchAlbums(artistId, maxAlbums, delayMs) {
  const albums = await fetchPages(`/artist/${artistId}/albums?limit=50`, {
    delayMs,
    maxItems: Math.max(maxAlbums * 3, maxAlbums), // fetch extra then filter/sort
  });
  return albums
    .filter((a) => !SKIP_ALBUM_RE.test(a.title || ""))
    .sort((a, b) => (b.fans || 0) - (a.fans || 0))
    .slice(0, maxAlbums);
}

async function fetchAlbumTracks(albumId, delayMs) {
  return fetchPages(`/album/${albumId}/tracks?limit=50`, {
    delayMs,
    maxItems: 80,
  });
}

async function fetchRelated(artistId, limit, delayMs) {
  if (limit <= 0) return [];
  const json = await deezer(`/artist/${artistId}/related?limit=${limit}`, { delayMs });
  return json?.data || [];
}

function loadSeeds() {
  const raw = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const byNorm = new Map();
  for (const a of raw.artists || []) {
    const key = normName(a.name);
    if (!key) continue;
    const origin = a.origin === "Brazilian" ? "Brazilian" : "International";
    const tier = a.tier || 3;
    const prev = byNorm.get(key);
    // keep best (lowest) tier; prefer explicit BR if conflict
    if (!prev || tier < prev.tier || (tier === prev.tier && origin === "Brazilian" && prev.origin !== "Brazilian")) {
      byNorm.set(key, {
        name: a.name,
        origin,
        genres: a.genres || [],
        tier,
      });
    }
  }
  return {
    metadata: raw.metadata || {},
    artists: [...byNorm.values()],
  };
}

function emptyCatalog(meta) {
  return {
    metadata: {
      ...meta,
      generated_at: new Date().toISOString(),
      quality_target: "320kbps",
      source: "deezer+seed-artists",
      curation: {
        brazilian: "deep+regional relevance (top tracks + popular albums)",
        international: "global essentials only (top tracks + few flagship albums, strict rank/fans)",
      },
      total_tracks: 0,
      brazilian_tracks: 0,
      international_tracks: 0,
      unique_artists: 0,
      unique_albums: 0,
      estimated_storage_gb_320kbps: 0,
    },
    items: [],
  };
}

function trackId(deezerTrackId, artist, album, title) {
  if (deezerTrackId) return `track-dz-${deezerTrackId}`;
  return `track-${slugify(artist)}-${slugify(album)}-${slugify(title)}`.slice(0, 120);
}

function estimateStorageGb(nTracks) {
  return Math.round(((nTracks * 8) / 1024) * 10) / 10;
}

function saveRawCatalogLocal(catalog) {
  const br = catalog.items.filter((t) => t.origin === "Brazilian").length;
  const intl = catalog.items.length - br;
  const artists = new Set(catalog.items.map((t) => t.artist));
  const albums = new Set(catalog.items.map((t) => `${t.artist}::${t.album}`));
  catalog.metadata.total_tracks = catalog.items.length;
  catalog.metadata.brazilian_tracks = br;
  catalog.metadata.international_tracks = intl;
  catalog.metadata.brazilian_ratio =
    catalog.items.length > 0 ? Math.round((br / catalog.items.length) * 1000) / 1000 : 0;
  catalog.metadata.unique_artists = artists.size;
  catalog.metadata.unique_albums = albums.size;
  catalog.metadata.estimated_storage_gb_320kbps = estimateStorageGb(catalog.items.length);
  catalog.metadata.updated_at = new Date().toISOString();
  catalog.metadata.raw = true;
  // Sharded under backend/data/music/raw/ (gitignored)
  saveRawToStore(catalog, { tracksPerShard: 15_000 });
}

/** Version-aware dedupe → backend/data/music/catalog/ (sharded). */
function runDedupe() {
  if (!fs.existsSync(DEDUPE_SCRIPT)) {
    console.warn("[music-catalog] dedupe script missing, skip");
    return;
  }
  const r = spawnSync(
    process.execPath,
    [DEDUPE_SCRIPT, "--in", "raw", "--out", "catalog", "--no-backup"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.warn("[music-catalog] dedupe exited", r.status);
  }
}

let lastDedupeAt = 0;
function saveCatalog(catalog, { dedupe = false } = {}) {
  saveRawCatalogLocal(catalog);
  // Full version-aware dedupe is expensive — only when asked or every ~10 min
  if (dedupe || Date.now() - lastDedupeAt > 10 * 60 * 1000) {
    runDedupe();
    lastDedupeAt = Date.now();
  }
}

function loadRawCatalog() {
  const cat = loadRawFromStore();
  if (cat.items?.length) return cat;
  return null;
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return null;
  return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
}



function countByOrigin(items) {
  let br = 0;
  let intl = 0;
  for (const t of items) {
    if (t.origin === "Brazilian") br++;
    else intl++;
  }
  return { br, intl };
}

function canAdd(origin, counts, target, brRatio) {
  if (counts.br + counts.intl >= target) return false;
  const brCap = Math.ceil(target * brRatio);
  const intlCap = target - brCap;
  if (origin === "Brazilian") {
    return counts.br < brCap || (counts.intl >= intlCap && counts.br + counts.intl < target);
  }
  return counts.intl < intlCap || (counts.br >= brCap && counts.br + counts.intl < target);
}

/**
 * Score a candidate track for relevance (higher = better).
 * /top tracks get a large bonus; rank from Deezer is the main signal.
 */
function relevanceScore(tr, { fromTop, albumFans = 0, origin }) {
  const rank = tr.rank || 0;
  const dur = tr.duration || 0;
  let score = rank;
  if (fromTop) score += 5_000_000;
  // mild album popularity boost for album-sourced tracks
  score += Math.min(albumFans, 200_000) * 0.05;
  // prefer radio-length tracks
  if (dur > 0 && (dur < 45 || dur > 900)) score *= 0.2;
  // intl: amplify rank gap so weak tracks fall away
  if (origin === "International") score = rank * 1.2 + (fromTop ? 5_000_000 : 0);
  return score;
}

function toItem(tr, { seed, resolved, albumMeta, origin, fromTop, score }) {
  const artistName = tr.artist?.name || resolved.name || seed.name;
  const albumTitle = albumMeta?.title || tr.album?.title || "Unknown Album";
  const title = tr.title || tr.title_short || "Unknown";
  const year = albumMeta?.release_date
    ? Number(String(albumMeta.release_date).slice(0, 4))
    : tr.album?.release_date
      ? Number(String(tr.album.release_date).slice(0, 4))
      : null;
  const cover =
    albumMeta?.cover_xl ||
    albumMeta?.cover_big ||
    albumMeta?.cover_medium ||
    tr.album?.cover_xl ||
    tr.album?.cover_big ||
    tr.album?.cover_medium ||
    null;

  return {
    id: trackId(tr.id, artistName, albumTitle, title),
    title,
    artist: artistName,
    album: albumTitle,
    year: Number.isFinite(year) ? year : null,
    duration_sec: tr.duration ?? null,
    track_number: tr.track_position ?? null,
    disc_number: tr.disk_number ?? 1,
    origin,
    genres: seed.genres || [],
    content_type: "track",
    quality_target: "320kbps",
    cover_url: cover,
    artist_picture:
      resolved.picture_xl || resolved.picture_big || resolved.picture_medium || null,
    deezer_track_id: tr.id,
    deezer_album_id: albumMeta?.id || tr.album?.id || null,
    deezer_artist_id: resolved.id,
    deezer_rank: tr.rank ?? null,
    relevance_score: Math.round(score),
    relevance_source: fromTop ? "artist_top" : "album",
    preview_url: tr.preview || null,
    explicit: Boolean(tr.explicit_lyrics),
    s3_key: null,
    s3_keys: [],
    encrypted: false,
    enrichment_status: "seed",
  };
}

/**
 * Collect relevant tracks for one artist, score, cap, return sorted best-first.
 */
async function collectArtistTracks({ seed, resolved, opts }) {
  const origin = seed.origin;
  const pol = policyFor(origin);
  const tier = seed.tier || 3;
  const minFans = pol.minFans[tier] ?? pol.minFans[3];
  const fans = resolved.nb_fan || 0;

  if (fans < minFans) {
    return { candidates: [], skipReason: `fans ${fans} < min ${minFans}` };
  }

  const topN = pol.topTracks[tier] ?? 20;
  const maxAlbums = pol.maxAlbums[tier] ?? 0;
  const minRank = pol.minRank[tier] ?? 0;

  /** @type {Map<number, {tr:any, fromTop:boolean, albumMeta:any, albumFans:number}>} */
  const bag = new Map();

  // 1) Artist top tracks — primary relevance signal
  const tops = await fetchTopTracks(resolved.id, topN, opts.delayMs);
  for (const tr of tops) {
    if (!tr?.id) continue;
    bag.set(tr.id, {
      tr,
      fromTop: true,
      albumMeta: tr.album || null,
      albumFans: 0,
    });
  }

  // 2) Popular albums (deep for BR, shallow flagship for intl)
  if (maxAlbums > 0) {
    const albums = await fetchAlbums(resolved.id, maxAlbums, opts.delayMs);
    for (const album of albums) {
      if (SKIP_ALBUM_RE.test(album.title || "")) continue;
      let albumDetail = album;
      if (!album.release_date || !album.cover_xl) {
        try {
          const full = await deezer(`/album/${album.id}`, { delayMs: opts.delayMs });
          if (full && !full.error) albumDetail = { ...album, ...full };
        } catch {
          /* keep list meta */
        }
      }
      const tracks = await fetchAlbumTracks(album.id, opts.delayMs);
      const albumFans = album.fans || albumDetail.fans || 0;
      for (const tr of tracks) {
        if (!tr?.id) continue;
        const prev = bag.get(tr.id);
        if (prev?.fromTop) continue; // keep top designation
        // For intl album fills: only keep high-rank tracks
        if (origin === "International" && (tr.rank || 0) < minRank) continue;
        if (!prev || (tr.rank || 0) > (prev.tr.rank || 0)) {
          bag.set(tr.id, {
            tr,
            fromTop: false,
            albumMeta: albumDetail,
            albumFans,
          });
        }
      }
    }
  }

  const candidates = [];
  for (const { tr, fromTop, albumMeta, albumFans } of bag.values()) {
    if (tr.duration != null && tr.duration > 0 && tr.duration < 30) continue;
    const rank = tr.rank || 0;
    // Top-list tracks always eligible (Deezer already ranked them relevant).
    // Album-sourced tracks must clear minRank.
    if (!fromTop && rank < minRank) continue;
    // International: even /top tracks that are extremely cold get dropped
    // (protects against obscure "top" of low-signal artists that passed fan gate).
    if (origin === "International" && !fromTop && rank < minRank) continue;
    if (origin === "International" && fromTop && rank < minRank * 0.25 && rank > 0) {
      // allow very low only if in top — but skip near-zero rank junk
      if (rank < 5_000) continue;
    }

    const score = relevanceScore(tr, { fromTop, albumFans, origin });
    candidates.push({ tr, fromTop, albumMeta, albumFans, score });
  }

  // No per-artist ceiling — keep every track that passed relevance gates
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, skipReason: null };
}

async function ingestArtist({ seed, resolved, catalog, seenTrackIds, counts, opts }) {
  const origin = seed.origin;
  const { candidates, skipReason } = await collectArtistTracks({ seed, resolved, opts });
  if (skipReason) return { added: 0, skipReason, related: [] };

  let added = 0;
  for (const c of candidates) {
    if (!canAdd(origin, counts, opts.target, opts.brRatio)) break;
    if (seenTrackIds.has(c.tr.id)) continue;

    const item = toItem(c.tr, {
      seed,
      resolved,
      albumMeta: c.albumMeta,
      origin,
      fromTop: c.fromTop,
      score: c.score,
    });
    catalog.items.push(item);
    seenTrackIds.add(c.tr.id);
    added++;
    if (origin === "Brazilian") counts.br++;
    else counts.intl++;
  }

  // Related artists: BR only (regional graph). Never for international.
  const pol = policyFor(origin);
  let related = [];
  const allowExpand =
    opts.expandRelated === null ? pol.expandRelated : opts.expandRelated && pol.expandRelated;
  if (allowExpand && pol.relatedLimit > 0) {
    try {
      related = await fetchRelated(resolved.id, pol.relatedLimit, opts.delayMs);
    } catch {
      related = [];
    }
  }

  return { added, skipReason: null, related };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("[music-catalog] options", opts);
  console.log("[music-catalog] policy: BR deep+regional | intl global-essentials only");

  const seeds = loadSeeds();
  console.log(
    `[music-catalog] seed artists (deduped): ${seeds.artists.length} ` +
      `(BR ${seeds.artists.filter((a) => a.origin === "Brazilian").length}, ` +
      `intl ${seeds.artists.filter((a) => a.origin === "International").length})`,
  );

  let catalog = emptyCatalog(seeds.metadata);
  let progress = {
    processed_artist_keys: [],
    queue: [],
    related_enqueued: 0,
    skipped_low_fans: 0,
  };
  const seenTrackIds = new Set();
  const processedKeys = new Set();
  const queuedKeys = new Set();

  if (opts.resume) {
    const existing = loadRawCatalog();
    const prev = loadProgress();
    if (existing?.items?.length) {
      catalog = existing;
      catalog.metadata.curation = catalog.metadata.curation || {
        brazilian: "deep+regional relevance",
        international: "global relevance; distinct versions kept after dedupe",
      };
      for (const t of catalog.items) {
        if (t.deezer_track_id) seenTrackIds.add(t.deezer_track_id);
        // also mark collapsed alts if present from a prior partial dedupe
        for (const id of t.alternate_deezer_ids || []) seenTrackIds.add(id);
      }
      console.log(
        `[music-catalog] resume: loaded ${catalog.items.length} raw rows ` +
          `(${seenTrackIds.size} known deezer ids)`,
      );
    }
    if (prev) {
      progress = prev;
      for (const k of progress.processed_artist_keys || []) processedKeys.add(k);
      console.log(`[music-catalog] resume: ${processedKeys.size} artists already processed`);
    }
  }

  const counts = countByOrigin(catalog.items);

  // Interleave BR/intl within tier so ratio stays healthy
  const initial = [];
  for (const tier of [1, 2, 3]) {
    const br = seeds.artists
      .filter((a) => a.tier === tier && a.origin === "Brazilian")
      .sort((a, b) => a.name.localeCompare(b.name));
    const intl = seeds.artists
      .filter((a) => a.tier === tier && a.origin !== "Brazilian")
      .sort((a, b) => a.name.localeCompare(b.name));
    const n = Math.max(br.length, intl.length);
    for (let i = 0; i < n; i++) {
      if (i < br.length) initial.push(br[i]);
      if (i < intl.length) initial.push(intl[i]);
    }
  }

  /** @type {{name:string,origin:string,genres:string[],tier:number,fromRelated?:boolean}[]} */
  const queue = [];
  function enqueue(artist) {
    const key = normName(artist.name);
    if (!key || processedKeys.has(key) || queuedKeys.has(key)) return false;
    queuedKeys.add(key);
    queue.push(artist);
    return true;
  }

  for (const a of initial) enqueue(a);
  for (const a of progress.queue || []) enqueue(a);

  let lastSave = Date.now();
  let artistsOk = 0;
  let artistsMiss = 0;
  let artistsSkipFans = 0;

  while (queue.length && counts.br + counts.intl < opts.target) {
    let seed = queue.shift();
    const key = normName(seed.name);
    queuedKeys.delete(key);
    if (processedKeys.has(key)) continue;

    // Prefer BR when ratio lagging
    const total = counts.br + counts.intl;
    const brRatioNow = total > 0 ? counts.br / total : 0;
    if (seed.origin !== "Brazilian" && brRatioNow < opts.brRatio - 0.05) {
      const idx = queue.findIndex((q) => q.origin === "Brazilian");
      if (idx >= 0) {
        const [br] = queue.splice(idx, 1);
        queue.unshift(seed);
        queuedKeys.add(key);
        seed = br;
      }
    }
    const processKey = normName(seed.name);
    if (processedKeys.has(processKey)) continue;

    process.stdout.write(
      `[music-catalog] (${counts.br + counts.intl}/${opts.target}) ` +
        `BR=${counts.br} intl=${counts.intl} | ${seed.origin[0]} T${seed.tier} ${seed.name} … `,
    );

    let resolved;
    try {
      resolved = await resolveArtist(seed.name, opts.delayMs);
    } catch (e) {
      console.log(`ERR resolve: ${e.message}`);
      processedKeys.add(processKey);
      progress.processed_artist_keys = [...processedKeys];
      continue;
    }

    if (!resolved) {
      console.log("not found");
      artistsMiss++;
      processedKeys.add(processKey);
      progress.processed_artist_keys = [...processedKeys];
      continue;
    }

    try {
      const { added, skipReason, related } = await ingestArtist({
        seed,
        resolved,
        catalog,
        seenTrackIds,
        counts,
        opts,
      });

      if (skipReason) {
        console.log(`skip (${skipReason}) dz=${resolved.id} fans=${resolved.nb_fan}`);
        artistsSkipFans++;
        progress.skipped_low_fans = (progress.skipped_low_fans || 0) + 1;
      } else {
        console.log(
          `dz=${resolved.id} fans=${resolved.nb_fan} +${added} ` +
            `(total ${counts.br + counts.intl})`,
        );
        artistsOk++;

        // Related expansion: BR always (regional); intl only mega peers
        if (related?.length) {
          for (const r of related) {
            const minRelatedFans = seed.origin === "Brazilian" ? 1_000 : 200_000;
            if ((r.nb_fan || 0) < minRelatedFans) continue;
            const ok = enqueue({
              name: r.name,
              origin: seed.origin,
              genres: seed.genres || [],
              tier: Math.min(3, (seed.tier || 2) + 1),
              fromRelated: true,
            });
            if (ok) progress.related_enqueued = (progress.related_enqueued || 0) + 1;
          }
        }
      }
    } catch (e) {
      console.log(`ERR ingest: ${e.message}`);
    }

    processedKeys.add(processKey);
    progress.processed_artist_keys = [...processedKeys];
    progress.queue = queue.slice(0, 500).map((a) => ({
      name: a.name,
      origin: a.origin,
      genres: a.genres,
      tier: a.tier,
      fromRelated: a.fromRelated || false,
    }));

    if (Date.now() - lastSave > 20_000) {
      saveCatalog(catalog, { dedupe: false });
      saveProgress(progress);
      lastSave = Date.now();
      console.log(
        `[music-catalog] saved raw ${catalog.items.length} → ${path.relative(ROOT, RAW_DIR)}`,
      );
    }
  }

  // Final: sort raw + always version-aware dedupe into sharded catalog/
  catalog.items.sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "Brazilian" ? -1 : 1;
    return (b.relevance_score || 0) - (a.relevance_score || 0);
  });

  saveCatalog(catalog, { dedupe: true });
  saveProgress(progress);

  console.log("\n[music-catalog] done");
  console.log(JSON.stringify(catalog.metadata, null, 2));
  console.log(
    `artists ok=${artistsOk} miss=${artistsMiss} skip_fans=${artistsSkipFans} ` +
      `related_enqueued=${progress.related_enqueued || 0}`,
  );
  console.log(`raw: ${RAW_DIR}`);
  console.log(`catalog: ${CATALOG_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
