#!/usr/bin/env node
/**
 * Unify *true* duplicates; keep distinct artistic versions separate.
 *
 * Collapse: same song on 12 compilations / remasters of the same studio cut
 * Keep separate: studio vs ao vivo, remix, acústico, instrumental, takes/mixes
 *
 * Playlists (albums/coletâneas) always kept — they only store track_ids refs.
 *
 * Usage:
 *   node scripts/catalog/dedupe-music-catalog.mjs
 *   node scripts/catalog/dedupe-music-catalog.mjs --in backend/data/music_catalog.pre-dedupe.json
 *   node scripts/catalog/dedupe-music-catalog.mjs --in a.json --merge b.json --out out.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadMusicCatalog,
  loadRawCatalog,
  saveMusicCatalog,
  CATALOG_DIR,
  RAW_DIR,
  LEGACY_RAW,
  LEGACY_PRE,
  LEGACY_CATALOG,
  INDEX_PATH,
} from "../../lib/music-catalog-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
/** Default: read raw (sharded or legacy), write sharded catalog/ */
const DEFAULT_IN = "raw";
const DEFAULT_OUT = CATALOG_DIR;

function parseArgs(argv) {
  const out = { inPath: DEFAULT_IN, outPath: DEFAULT_OUT, mergePaths: [], backup: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") out.inPath = argv[++i];
    else if (argv[i] === "--out") out.outPath = argv[++i];
    else if (argv[i] === "--merge") out.mergePaths.push(argv[++i]);
    else if (argv[i] === "--no-backup") out.backup = false;
  }
  return out;
}

/** Resolve path or special tokens "raw" / "catalog" to a catalog object. */
function loadFromSpec(spec) {
  if (!spec || spec === "raw") return loadRawCatalog();
  if (spec === "catalog") return loadMusicCatalog();
  const p = path.resolve(ROOT, spec);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    return loadMusicCatalog({ catalogDir: p });
  }
  if (fs.existsSync(p)) {
    return loadMusicCatalog({ legacyPath: p });
  }
  // try as catalog dir relative
  const asDir = path.join(ROOT, spec);
  if (fs.existsSync(asDir)) return loadMusicCatalog({ catalogDir: asDir });
  return { metadata: {}, items: [], playlists: [] };
}

function stripDiacritics(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Strip version noise for matching the *song identity*, but versionClass()
 * decides whether two rows are the same cut.
 */
export function baseTitle(title) {
  let t = stripDiacritics(title).toLowerCase();
  t = t.replace(/\s*[\(\[]?\s*(feat\.?|ft\.?|featuring|with|com)\s+[^)\]]+[\)\]]?/gi, " ");
  // remove parentheticals (version tags live there)
  t = t.replace(/[\(\[\{][^)\]\}]{0,120}[\)\]\}]/g, " ");
  t = t.replace(
    /\s*[-–—:]\s*(ao vivo.*|live.*|remaster(?:ed)?.*|radio edit.*|album version.*|single version.*|extended.*|remix.*|mix.*|edit.*|version.*|acoustic.*|unplugged.*|demo.*|instrumental.*|karaoke.*|mono.*|stereo.*|deluxe.*|bonus.*|take \d+.*|vers[aã]o.*)\s*$/i,
    " ",
  );
  t = t.replace(
    /\b(ao vivo|live|remaster(?:ed)?|radio edit|extended version|album version|single version|bonus track|deluxe|mono|stereo|instrumental|acoustic|unplugged|demo|remix|edit|karaoke|super deluxe|anniversary|take \d+|rooftop performance|naked version|film edit|epic version|vers[aã]o grave|vers[aã]o \d+)\b/gi,
    " ",
  );
  t = t.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return t;
}

/**
 * Artistic version class — rows with different classes are NOT unified.
 *
 * studio  — default studio cut (remasters of same studio track collapse here)
 * live    — ao vivo / concert
 * remix   — remix, club mix, mashup, versão grave (BR funk edits)
 * acoustic — unplugged / acústico
 * instrumental
 * mix     — alternate mix year / Giles Martin style (2015 Mix, 2017 Mix)
 * demo    — take N, demo, naked version
 * other   — explicit "versão 2" etc.
 */
export function versionClass(title, album = "") {
  const t = `${title || ""} ${album || ""}`;
  const lower = t.toLowerCase();

  if (/\b(karaoke|tribute|in the style of)\b/i.test(t)) return "karaoke";

  if (
    /\b(ao vivo|live|in concert|unplugged|rooftop|on stage|mtv ao vivo|come back special)\b/i.test(
      t,
    )
  ) {
    return "live";
  }
  if (
    /\b(remix|mashup|club mix|extended mix|radio edit|bootleg|vers[aã]o grave)\b/i.test(t)
  ) {
    return "remix";
  }
  if (/\b(acoustic|ac[uú]stic[oa]?|unplugged)\b/i.test(t)) return "acoustic";
  if (/\b(instrumental)\b/i.test(t)) return "instrumental";
  if (/\b(take \d+|demo|naked version|session)\b/i.test(t)) return "demo";
  // Alternate artistic mixes (keep separate from plain remaster)
  if (/\b(20\d{2}\s*mix|stereo mix|mono mix|giles|film edit|epic version)\b/i.test(t)) {
    return "mix";
  }
  if (/\bvers[aã]o\s*\d+\b/i.test(t) || /\bversion\s*\d+\b/i.test(lower)) return "other";

  // remaster / deluxe / anthology without other tags → still studio performance
  return "studio";
}

function normArtist(a) {
  return stripDiacritics(a)
    .toLowerCase()
    .replace(/&/g, "e")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Unify only same song + same version class. */
export function songKey(track) {
  const base = baseTitle(track.title);
  const ver = versionClass(track.title, track.album);
  const artist = normArtist(track.artist);
  if (!base) return `id||${track.deezer_track_id || track.id}||${ver}`;
  return `${artist}||${base}||${ver}`;
}

function albumKey(track) {
  const artist = normArtist(track.artist);
  const album = stripDiacritics(track.album || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `${artist}||${album}`;
}

function slugify(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isLiveTitle(title) {
  return versionClass(title, "") === "live";
}

function isLiveAlbum(album) {
  return /\b(ao vivo|live|in concert|unplugged|mtv ao vivo|come back special)\b/i.test(
    album || "",
  );
}

function isCompilationAlbum(album) {
  return /\b(greatest hits|best of|the very best|cole[cç][aã]o|antologia|essentials?|\bhits\b|gold|platinum|mais tocadas|as melhores|repert[oó]rio|sele[cç][aã]o|sem limite|maxximum|50 anos|70 anos|60 greatest|40 greatest|defintive|completo|original album series|grandes nomes|s[eé]rie|20 super sucessos)\b/i.test(
    album || "",
  );
}

function isRemasterNoise(title, album) {
  const t = `${title || ""} ${album || ""}`;
  return /\b(remaster|super deluxe|anniversary edition|expanded edition)\b/i.test(t);
}

/**
 * Prefer: non-compilation studio source, high rank, clean title.
 * Within the same versionClass only.
 */
function canonicalScore(t) {
  let s = Number(t.deezer_rank || t.relevance_score || 0);
  if (t.relevance_source === "artist_top") s += 50_000;
  if (isCompilationAlbum(t.album)) s -= 300_000;
  if (isRemasterNoise(t.title, t.album)) s -= 40_000;
  // prefer cleaner title for display
  if (!/[\(\[]/.test(t.title || "")) s += 20_000;
  if (t.duration_sec && t.duration_sec >= 90 && t.duration_sec <= 480) s += 5_000;
  // live/remix already separated by key — mild rank is enough
  return s;
}

function playlistKind(album) {
  if (isCompilationAlbum(album)) return "compilation";
  if (isLiveAlbum(album)) return "live_album";
  if (isRemasterNoise("", album)) return "reissue";
  return "album";
}

function collectItems(specs) {
  const items = [];
  const seenDz = new Set();
  for (const spec of specs) {
    const cat = loadFromSpec(spec);
    if (!cat.items?.length) {
      console.warn("[dedupe-music] skip empty", spec);
      continue;
    }
    for (const t of cat.items) {
      const dz = t.deezer_track_id;
      if (dz != null) {
        if (seenDz.has(dz)) continue;
        seenDz.add(dz);
      }
      items.push(t);
    }
  }
  return items;
}

function dedupeItems(items) {
  /** @type {Map<string, typeof items>} */
  const bySong = new Map();
  for (const t of items) {
    // drop karaoke/tribute entirely
    const ver = versionClass(t.title, t.album);
    if (ver === "karaoke") continue;
    const k = songKey(t);
    if (!bySong.has(k)) bySong.set(k, []);
    bySong.get(k).push(t);
  }

  const canonical = new Map();
  const redirect = new Map();
  let multiVersionSongs = 0;
  let versionsCollapsed = 0;
  const versionBreakdown = {};

  for (const [key, group] of bySong) {
    group.sort((a, b) => canonicalScore(b) - canonicalScore(a));
    const winner = { ...group[0] };
    const ver = key.split("||").pop();
    versionBreakdown[ver] = (versionBreakdown[ver] || 0) + 1;
    winner.version_class = versionClass(winner.title, winner.album);
    winner.alternate_versions = group.length - 1;
    winner.alternate_deezer_ids = group
      .slice(1)
      .map((g) => g.deezer_track_id)
      .filter(Boolean);

    const winId = winner.id;
    canonical.set(winId, winner);
    if (group.length > 1) {
      multiVersionSongs++;
      versionsCollapsed += group.length - 1;
    }
    for (const g of group) {
      if (g.id) redirect.set(g.id, winId);
      if (g.deezer_track_id) redirect.set(`dz:${g.deezer_track_id}`, winId);
    }
  }

  return { canonical, redirect, multiVersionSongs, versionsCollapsed, versionBreakdown };
}

function buildPlaylists(items, redirect) {
  /** @type {Map<string, any>} */
  const playlists = new Map();

  for (const t of items) {
    if (versionClass(t.title, t.album) === "karaoke") continue;
    const ak = albumKey(t);
    const canonId =
      redirect.get(t.id) ||
      (t.deezer_track_id ? redirect.get(`dz:${t.deezer_track_id}`) : null);
    if (!canonId) continue;

    if (!playlists.has(ak)) {
      playlists.set(ak, {
        id: t.deezer_album_id
          ? `album-dz-${t.deezer_album_id}`
          : `album-${slugify(t.artist)}-${slugify(t.album)}`,
        title: t.album || "Unknown Album",
        artist: t.artist,
        origin: t.origin,
        cover_url: t.cover_url || null,
        year: t.year ?? null,
        kind: playlistKind(t.album),
        deezer_album_id: t.deezer_album_id ?? null,
        track_ids: new Set(),
        source_track_count: 0,
      });
    }
    const pl = playlists.get(ak);
    pl.track_ids.add(canonId);
    pl.source_track_count++;
    if (!pl.cover_url && t.cover_url) pl.cover_url = t.cover_url;
    if (pl.year == null && t.year != null) pl.year = t.year;
  }

  return [...playlists.values()]
    .map((p) => ({
      id: p.id,
      title: p.title,
      artist: p.artist,
      origin: p.origin,
      cover_url: p.cover_url,
      year: p.year,
      kind: p.kind,
      deezer_album_id: p.deezer_album_id,
      track_ids: [...p.track_ids],
      track_count: p.track_ids.size,
      source_track_count: p.source_track_count,
    }))
    .sort((a, b) => b.track_count - a.track_count);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputs = [opts.inPath, ...opts.mergePaths];
  console.log("[dedupe-music] inputs:", inputs.join(", "));
  console.log("[dedupe-music] policy: unify same song+version; keep live/remix/acoustic/mix separate");

  const items = collectItems(inputs);
  if (!items.length) {
    console.error("no items");
    process.exit(1);
  }

  const { canonical, redirect, multiVersionSongs, versionsCollapsed, versionBreakdown } =
    dedupeItems(items);

  // Build playlists from *all* source rows so every compilation survives
  const playlistList = buildPlaylists(items, redirect);

  const uniqueTracks = [...canonical.values()].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "Brazilian" ? -1 : 1;
    return (b.deezer_rank || 0) - (a.deezer_rank || 0);
  });

  const br = uniqueTracks.filter((t) => t.origin === "Brazilian").length;
  const intl = uniqueTracks.length - br;

  const elis = uniqueTracks.filter((t) => /elis regina/i.test(t.artist || ""));
  const elisByVer = {};
  for (const t of elis) {
    const v = t.version_class || versionClass(t.title, t.album);
    elisByVer[v] = (elisByVer[v] || 0) + 1;
  }

  const out = {
    metadata: {
      target_tracks: 100000,
      target_bitrate: "320kbps",
      target_brazilian_ratio: 0.33,
      quality_target: "320kbps",
      source: "deezer+seed-artists",
      curation: {
        brazilian: "deep+regional relevance",
        international: "global relevance (rank/fans)",
        dedupe:
          "same song+version_class unified; live/remix/acoustic/mix/demo kept separate; playlists ref track_ids",
      },
      total_tracks: uniqueTracks.length,
      brazilian_tracks: br,
      international_tracks: intl,
      brazilian_ratio:
        uniqueTracks.length > 0 ? Math.round((br / uniqueTracks.length) * 1000) / 1000 : 0,
      unique_artists: new Set(uniqueTracks.map((t) => t.artist)).size,
      unique_albums: playlistList.length,
      playlists_count: playlistList.length,
      estimated_storage_gb_320kbps:
        Math.round(((uniqueTracks.length * 8) / 1024) * 10) / 10,
      version_breakdown: versionBreakdown,
      deduped_at: new Date().toISOString(),
      dedupe: {
        input_tracks: items.length,
        output_tracks: uniqueTracks.length,
        versions_collapsed: versionsCollapsed,
        songs_with_multiple_copies: multiVersionSongs,
        playlists: playlistList.length,
        note: "Playlists keep all albums/compilations as track_id refs. Distinct versions (live vs studio etc.) are separate items.",
      },
      updated_at: new Date().toISOString(),
    },
    items: uniqueTracks,
    playlists: playlistList,
  };

  // Always write sharded catalog (never a 100MB+ monolith)
  const outDir =
    opts.outPath === "catalog" || opts.outPath === DEFAULT_OUT
      ? CATALOG_DIR
      : path.resolve(ROOT, opts.outPath);
  const saved = saveMusicCatalog(out, { catalogDir: outDir, tracksPerShard: 12_000 });

  console.log("[dedupe-music] done (sharded)");
  console.log(
    JSON.stringify(
      {
        input: items.length,
        output_tracks: uniqueTracks.length,
        collapsed: versionsCollapsed,
        multi_copy_groups: multiVersionSongs,
        playlists: playlistList.length,
        br,
        intl,
        version_breakdown: versionBreakdown,
        elis_by_version: elisByVer,
        storage_gb: out.metadata.estimated_storage_gb_320kbps,
        out: outDir,
        shards: Object.fromEntries(
          Object.entries(saved.sizes).map(([k, v]) => [k, `${(v / 1e6).toFixed(1)}MB`]),
        ),
      },
      null,
      2,
    ),
  );
}

main();
