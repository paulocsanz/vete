#!/usr/bin/env node
/**
 * Batch version of repick-stuck-movies.mjs: for every catalog item with no
 * video AND no torrent_options on record, query Torrentio (movie or series
 * endpoint depending on content_type) for fresh candidates. Read-only
 * against the catalog except for items that get real results - writes new
 * torrent_options[_720p] and resets the index to 0.
 *
 * Usage: node scripts/pipeline/find-torrents-for-stuck.mjs
 */
import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const TORRENTIO_BASE = "https://torrentio.strem.fun/stream";
const BR = "https://torrentio.strem.fun/brazuca/stream";
const OMDB_API_KEYS = (process.env.OMDB_API_KEYS || "").split(",").filter(Boolean);

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];

function buildMagnet(infoHash, title) {
  const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&${tr}`;
}

function parseStreamMeta(stream) {
  const lines = (stream.title || "").split("\n");
  const releaseTitle = lines[0] || stream.title;
  const metaLine = lines[1] || "";
  const seedMatch = metaLine.match(/👤\s*(\d+)/);
  const sizeMatch = metaLine.match(/💾\s*([\d.]+\s*\w+)/);
  return {
    title: releaseTitle,
    seeders: seedMatch ? parseInt(seedMatch[1], 10) : 0,
    size: sizeMatch ? sizeMatch[1].trim() : null,
  };
}

function toOption(s) {
  const meta = parseStreamMeta(s);
  return { title: meta.title, magnet: buildMagnet(s.infoHash, meta.title), seeders: meta.seeders, size: meta.size, provider: "Torrentio" };
}

async function fetchStreams(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const json = await res.json();
    return json.streams || [];
  } catch {
    return [];
  }
}

async function omdbFindImdbId(title, year) {
  for (const key of OMDB_API_KEYS) {
    try {
      const res = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${year || ""}&apikey=${key}`);
      const j = await res.json();
      if (j.Response === "True" && j.imdbID) return j.imdbID;
    } catch {}
  }
  return null;
}

const isJunk = (t) => /\b(CAM|TS|TC|SCREENER|R5)\b/i.test(t);

function sourceKeys(item) {
  if (item.s3_keys?.length) return item.s3_keys;
  if (item.s3_key) return [item.s3_key];
  return [];
}

function findStuckItems(catalog) {
  return catalog.items.filter((i) => {
    if (!i) return false;
    const noOpts = (!i.torrent_options?.length) && (!i.torrent_options_720p?.length);
    const noVideo = sourceKeys(i).length === 0 && !i.hls_playlist_s3_key;
    return noOpts && noVideo;
  });
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
}

function saveItemUpdate(id, fields) {
  const fresh = loadCatalog();
  const items = fresh.items || fresh;
  const freshItem = items.find((x) => x && x.id === id);
  if (!freshItem) {
    console.log(`  ⚠ ${id} vanished from catalog before save, skipping write`);
    return;
  }
  Object.assign(freshItem, fields);
  const out = fresh.items ? fresh : items;
  const tmp = `${ENRICHED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  fs.renameSync(tmp, ENRICHED_FILE);
}

async function main() {
  const initial = loadCatalog();
  const stuck = findStuckItems({ items: initial.items || initial });
  console.log(`${stuck.length} stuck item(s) to search\n`);

  let found = 0;
  let stillNothing = 0;

  for (const item of stuck) {
    console.log(`=== ${item.title} (${item.year}, ${item.content_type}) ===`);
    const fields = {};
    let imdbId = item.imdb_id;
    if (!imdbId) {
      imdbId = await omdbFindImdbId(item.title, item.year);
      if (imdbId) {
        console.log(`  found imdb_id via OMDb: ${imdbId}`);
        fields.imdb_id = imdbId;
      }
    }
    if (!imdbId) {
      console.log("  ⚠ no imdb_id, skipping");
      stillNothing++;
      continue;
    }

    const isTv = item.content_type === "tv";
    const suffix = isTv ? `series/${imdbId}:1:1.json` : `movie/${imdbId}.json`;
    const [streams, brStreams] = await Promise.all([
      fetchStreams(`${TORRENTIO_BASE}/${suffix}`),
      fetchStreams(`${BR}/${suffix}`),
    ]);
    const all = [...streams, ...brStreams];
    const seen = new Set();
    const deduped = all.filter((s) => {
      if (!s.infoHash || seen.has(s.infoHash)) return false;
      seen.add(s.infoHash);
      return true;
    });
    console.log(`  streams found: ${deduped.length}`);

    if (deduped.length === 0) {
      if (Object.keys(fields).length) saveItemUpdate(item.id, fields);
      stillNothing++;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    const options = deduped.map(toOption).filter((o) => !isJunk(o.title));
    const p1080 = options.filter((o) => /1080p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const p720 = options.filter((o) => /720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const other = options.filter((o) => !/1080p/i.test(o.title) && !/720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);

    const new1080 = (p1080.length ? p1080 : other).slice(0, 10);
    const new720 = p720.slice(0, 10);

    if (new1080.length === 0 && new720.length === 0) {
      console.log("  ⚠ only junk-quality results, skipping");
      if (Object.keys(fields).length) saveItemUpdate(item.id, fields);
      stillNothing++;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    fields.torrent_options = new1080;
    fields.torrent_options_720p = new720;
    fields.current_torrent_index = 0;
    fields.current_torrent_index_720p = 0;
    console.log(`  ✓ ${new1080.length} primary + ${new720.length} 720p option(s)`);
    if (new1080[0]) console.log(`    best: ${new1080[0].title} (${new1080[0].seeders} seeders)`);
    saveItemUpdate(item.id, fields);
    found++;

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. ${found} found, ${stillNothing} still nothing.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
