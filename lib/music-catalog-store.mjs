/**
 * Sharded music catalog I/O.
 *
 * Layout (all compact JSON, no pretty-print — keeps shards well under GitHub 100MB):
 *   backend/data/music/catalog/index.json      — metadata + shard manifest
 *   backend/data/music/catalog/tracks-NNN.json — { "items": [ ... ] }
 *   backend/data/music/catalog/playlists.json  — { "playlists": [ ... ] }  (or sharded if huge)
 *
 * Legacy monolith paths still loadable for migration.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const MUSIC_DIR = path.join(ROOT, "backend/data/music");
export const CATALOG_DIR = path.join(MUSIC_DIR, "catalog");
export const INDEX_PATH = path.join(CATALOG_DIR, "index.json");
export const PLAYLISTS_PATH = path.join(CATALOG_DIR, "playlists.json");

/** Legacy monoliths — gitignored; may still exist on disk for generators. */
export const LEGACY_CATALOG = path.join(ROOT, "backend/data/music_catalog.json");
export const LEGACY_RAW = path.join(ROOT, "backend/data/music_catalog.raw.json");
export const LEGACY_PRE = path.join(ROOT, "backend/data/music_catalog.pre-dedupe.json");

/** ~20MB target per tracks shard at compact encoding (~25k tracks/shard at ~0.8KB avg). */
export const DEFAULT_TRACKS_PER_SHARD = 12_000;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJsonCompact(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj));
}

/**
 * Load full catalog { metadata, items, playlists } from sharded dir or legacy file.
 */
export function loadMusicCatalog(opts = {}) {
  const catalogDir = opts.catalogDir || CATALOG_DIR;
  const indexPath = path.join(catalogDir, "index.json");

  if (fs.existsSync(indexPath)) {
    const index = readJson(indexPath);
    const items = [];
    for (const rel of index.track_shards || []) {
      const shardPath = path.join(catalogDir, rel);
      if (!fs.existsSync(shardPath)) {
        throw new Error(`missing track shard: ${shardPath}`);
      }
      const shard = readJson(shardPath);
      const arr = Array.isArray(shard) ? shard : shard.items || [];
      items.push(...arr);
    }
    let playlists = [];
    if (index.playlist_shards?.length) {
      for (const rel of index.playlist_shards) {
        const shard = readJson(path.join(catalogDir, rel));
        playlists.push(...(Array.isArray(shard) ? shard : shard.playlists || []));
      }
    } else if (index.playlists_file) {
      const p = path.join(catalogDir, index.playlists_file);
      if (fs.existsSync(p)) {
        const pl = readJson(p);
        playlists = Array.isArray(pl) ? pl : pl.playlists || [];
      }
    }
    return {
      metadata: index.metadata || {},
      items,
      playlists,
    };
  }

  // Legacy single-file fallbacks
  for (const legacy of [opts.legacyPath, LEGACY_CATALOG, LEGACY_RAW, LEGACY_PRE].filter(Boolean)) {
    if (legacy && fs.existsSync(legacy)) {
      const raw = readJson(legacy);
      return {
        metadata: raw.metadata || {},
        items: raw.items || [],
        playlists: raw.playlists || [],
      };
    }
  }

  return { metadata: {}, items: [], playlists: [] };
}

/**
 * Write catalog as shards. Returns index summary.
 */
export function saveMusicCatalog(catalog, opts = {}) {
  const catalogDir = opts.catalogDir || CATALOG_DIR;
  const perShard = opts.tracksPerShard || DEFAULT_TRACKS_PER_SHARD;
  const items = catalog.items || [];
  const playlists = catalog.playlists || [];
  const metadata = { ...(catalog.metadata || {}) };

  ensureDir(catalogDir);

  // Remove old track shards in this dir
  for (const name of fs.readdirSync(catalogDir)) {
    if (/^tracks-\d+\.json$/.test(name) || /^playlists-\d+\.json$/.test(name)) {
      fs.unlinkSync(path.join(catalogDir, name));
    }
  }

  const track_shards = [];
  for (let i = 0, shard = 0; i < items.length; i += perShard, shard++) {
    const slice = items.slice(i, i + perShard);
    const rel = `tracks-${String(shard).padStart(3, "0")}.json`;
    writeJsonCompact(path.join(catalogDir, rel), { items: slice });
    track_shards.push(rel);
  }

  // Playlists: single file unless huge
  let playlists_file = "playlists.json";
  let playlist_shards = null;
  const plSize = Buffer.byteLength(JSON.stringify(playlists));
  if (plSize > 40 * 1024 * 1024) {
    playlist_shards = [];
    const plPer = Math.ceil(playlists.length / Math.ceil(plSize / (25 * 1024 * 1024)));
    for (let i = 0, shard = 0; i < playlists.length; i += plPer, shard++) {
      const rel = `playlists-${String(shard).padStart(3, "0")}.json`;
      writeJsonCompact(path.join(catalogDir, rel), {
        playlists: playlists.slice(i, i + plPer),
      });
      playlist_shards.push(rel);
    }
    playlists_file = null;
    if (fs.existsSync(path.join(catalogDir, "playlists.json"))) {
      fs.unlinkSync(path.join(catalogDir, "playlists.json"));
    }
  } else {
    writeJsonCompact(path.join(catalogDir, playlists_file), { playlists });
  }

  metadata.total_tracks = items.length;
  metadata.playlists_count = playlists.length;
  metadata.updated_at = new Date().toISOString();
  metadata.storage = {
    format: "sharded-v1",
    track_shards: track_shards.length,
    tracks_per_shard: perShard,
  };

  const index = {
    version: 1,
    metadata,
    track_shards,
    playlists_file,
    playlist_shards,
  };
  // index is small — pretty for humans
  fs.writeFileSync(path.join(catalogDir, "index.json"), JSON.stringify(index, null, 2));

  const sizes = {};
  for (const rel of track_shards) {
    sizes[rel] = fs.statSync(path.join(catalogDir, rel)).size;
  }
  if (playlists_file) {
    sizes[playlists_file] = fs.statSync(path.join(catalogDir, playlists_file)).size;
  }
  if (playlist_shards) {
    for (const rel of playlist_shards) {
      sizes[rel] = fs.statSync(path.join(catalogDir, rel)).size;
    }
  }
  sizes["index.json"] = fs.statSync(path.join(catalogDir, "index.json")).size;

  return { index, sizes, catalogDir, trackCount: items.length, playlistCount: playlists.length };
}

/** Load raw (pre-dedupe) catalog from gitignored raw dir or legacy file. */
export const RAW_DIR = path.join(MUSIC_DIR, "raw");
export const RAW_INDEX = path.join(RAW_DIR, "index.json");

export function loadRawCatalog() {
  if (fs.existsSync(RAW_INDEX)) {
    return loadMusicCatalog({ catalogDir: RAW_DIR });
  }
  if (fs.existsSync(LEGACY_RAW)) {
    return loadMusicCatalog({ legacyPath: LEGACY_RAW });
  }
  if (fs.existsSync(LEGACY_PRE)) {
    return loadMusicCatalog({ legacyPath: LEGACY_PRE });
  }
  if (fs.existsSync(INDEX_PATH)) {
    return loadMusicCatalog();
  }
  if (fs.existsSync(LEGACY_CATALOG)) {
    return loadMusicCatalog({ legacyPath: LEGACY_CATALOG });
  }
  return { metadata: {}, items: [], playlists: [] };
}

export function saveRawCatalog(catalog, opts = {}) {
  return saveMusicCatalog(catalog, {
    catalogDir: RAW_DIR,
    tracksPerShard: opts.tracksPerShard || 15_000,
  });
}
