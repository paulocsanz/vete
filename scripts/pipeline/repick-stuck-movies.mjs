#!/usr/bin/env node
/**
 * One-off: find fresh Torrentio candidates for movies whose only/current
 * torrent option turned out corrupt or exhausted, with no fallback left.
 * Read-only against the catalog except for the specific ids listed here -
 * writes new torrent_options[_720p] and resets the index to 0 so the
 * caixote pipeline picks them up on its next pass.
 *
 * Usage: node scripts/pipeline/repick-stuck-movies.mjs
 */
import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const TORRENTIO_BASE = "https://torrentio.strem.fun/stream";
const BR = "https://torrentio.strem.fun/brazuca/stream";

const TARGETS = [
  { id: "the-man-who-copied-2003-movie", imdb: "tt0367859" },
  { id: "won-t-you-be-my-neighbor-2018-movie", imdb: "tt7681902" },
  { id: "to-the-left-of-the-father-2001-movie", imdb: "tt0241663" },
  { id: "me-you-them-2000-movie", imdb: "tt0244504" },
];

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

async function fetchStreams(imdbId, base) {
  const url = `${base}/movie/${imdbId}.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.streams || [];
  } catch (e) {
    console.log("  Error:", e.message);
    return [];
  }
}

const isJunk = (t) => /\b(CAM|TS|TC|SCREENER|R5)\b/i.test(t);

async function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const items = data.items || data;

  for (const target of TARGETS) {
    const item = items.find((i) => i.id === target.id);
    if (!item) {
      console.log(`\n=== ${target.id} === NOT FOUND in catalog`);
      continue;
    }
    console.log(`\n=== ${item.title} (${target.imdb}) ===`);
    const [streams, brStreams] = await Promise.all([
      fetchStreams(target.imdb, TORRENTIO_BASE),
      fetchStreams(target.imdb, BR),
    ]);
    const all = [...streams, ...brStreams];
    const seen = new Set();
    const deduped = all.filter((s) => {
      if (!s.infoHash || seen.has(s.infoHash)) return false;
      seen.add(s.infoHash);
      return true;
    });
    console.log(`  streams found: ${deduped.length}`);

    const options = deduped.map(toOption).filter((o) => !isJunk(o.title));
    const p1080 = options.filter((o) => /1080p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const p720 = options.filter((o) => /720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const other = options.filter((o) => !/1080p/i.test(o.title) && !/720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);

    console.log(`  1080p: ${p1080.length}, 720p: ${p720.length}, other: ${other.length}`);
    if (p1080[0]) console.log(`  best 1080p: ${p1080[0].title} (${p1080[0].seeders} seeders)`);
    if (p720[0]) console.log(`  best 720p: ${p720[0].title} (${p720[0].seeders} seeders)`);

    const new1080 = (p1080.length ? p1080 : other).slice(0, 10);
    const new720 = p720.slice(0, 10);

    if (new1080.length === 0 && new720.length === 0) {
      console.log(`  ⚠ no usable candidates found, leaving existing options untouched`);
      continue;
    }

    item.torrent_options = new1080;
    item.torrent_options_720p = new720;
    item.current_torrent_index = 0;
    item.current_torrent_index_720p = 0;
    console.log(`  ✓ updated: ${new1080.length} primary option(s), ${new720.length} 720p option(s)`);
  }

  const out = data.items ? data : { items };
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log("\nSaved.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
