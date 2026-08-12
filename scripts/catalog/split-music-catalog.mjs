#!/usr/bin/env node
/**
 * Migrate monolithic music_catalog*.json into sharded layout under
 * backend/data/music/catalog/ (and optional raw/).
 *
 *   node scripts/catalog/split-music-catalog.mjs
 *   node scripts/catalog/split-music-catalog.mjs --also-raw
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadMusicCatalog,
  saveMusicCatalog,
  saveRawCatalog,
  LEGACY_CATALOG,
  LEGACY_RAW,
  LEGACY_PRE,
  CATALOG_DIR,
  RAW_DIR,
  INDEX_PATH,
} from "../../lib/music-catalog-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function mb(n) {
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function main() {
  const alsoRaw = process.argv.includes("--also-raw");

  // Prefer current monolith / existing shard as source of truth for live catalog
  let source = null;
  if (fs.existsSync(LEGACY_CATALOG)) source = LEGACY_CATALOG;
  else if (fs.existsSync(INDEX_PATH)) source = INDEX_PATH;
  else if (fs.existsSync(LEGACY_PRE)) source = LEGACY_PRE;
  else if (fs.existsSync(LEGACY_RAW)) source = LEGACY_RAW;

  if (!source) {
    console.error("no music catalog source found");
    process.exit(1);
  }

  console.log("[split-music] live source:", path.relative(ROOT, source));
  const live = loadMusicCatalog({
    legacyPath: source.endsWith("index.json") ? undefined : source,
    catalogDir: source.endsWith("index.json") ? path.dirname(source) : undefined,
  });
  console.log(`  items=${live.items.length} playlists=${live.playlists?.length || 0}`);

  const result = saveMusicCatalog(live, { tracksPerShard: 12_000 });
  console.log("[split-music] wrote", path.relative(ROOT, CATALOG_DIR));
  for (const [name, size] of Object.entries(result.sizes)) {
    const flag = size > 50 * 1024 * 1024 ? " ⚠️ >50MB" : size > 90 * 1024 * 1024 ? " ❌ >90MB" : "";
    console.log(`  ${name}: ${mb(size)}${flag}`);
  }

  if (alsoRaw) {
    const rawPath = fs.existsSync(LEGACY_RAW)
      ? LEGACY_RAW
      : fs.existsSync(LEGACY_PRE)
        ? LEGACY_PRE
        : null;
    if (rawPath) {
      console.log("[split-music] raw source:", path.relative(ROOT, rawPath));
      const raw = loadMusicCatalog({ legacyPath: rawPath });
      const rr = saveRawCatalog(raw, { tracksPerShard: 15_000 });
      console.log("[split-music] wrote", path.relative(ROOT, RAW_DIR));
      for (const [name, size] of Object.entries(rr.sizes)) {
        console.log(`  ${name}: ${mb(size)}`);
      }
    }
  }

  console.log("[split-music] done — monoliths can stay on disk but should be gitignored");
}

main();
