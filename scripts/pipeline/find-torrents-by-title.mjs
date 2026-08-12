#!/usr/bin/env node
/**
 * Second pass for items find-torrents-for-stuck.mjs missed: that script is
 * IMDb-ID based (Torrentio's catalog endpoints), which misses anything a
 * tracker indexed without solid IMDb-ID metadata - common for Brazilian TV.
 * This one does a free-text search (title_pt, falling back to title) against
 * ThePirateBay directly, a genuinely different method, not just a retry.
 *
 * Usage: node scripts/pipeline/find-torrents-by-title.mjs
 */
import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");

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

async function tpbSearch(query) {
  try {
    const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter((t) => t.info_hash !== "0000000000000000000000000000000000000000");
  } catch {
    return [];
  }
}

function toOption(t) {
  return {
    title: t.name,
    magnet: buildMagnet(t.info_hash, t.name),
    seeders: parseInt(t.seeders, 10) || 0,
    size: `${(parseInt(t.size, 10) / 1024 / 1024).toFixed(0)}MB`,
    provider: "ThePirateBay",
  };
}

const isJunk = (t) =>
  /\b(CAM|TS|TC|SCREENER|R5|XXX)\b/i.test(t) ||
  /flac|mp3|discografia|trilha sonora|soundtrack|\bost\b|\balbum\b|\bcd\b|\[art\d+\]/i.test(t);

const hasVideoSignal = (t) =>
  /1080p|720p|480p|web-?dl|bluray|brrip|dvdrip|hdtv|webrip|hdrip|x264|x265|hevc/i.test(t);

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
  console.log(`${stuck.length} stuck item(s) to search by title\n`);

  let found = 0;
  let stillNothing = 0;

  for (const item of stuck) {
    const baseQuery = item.title_pt || item.title;
    const isMovie = item.content_type === "movie";
    const query = isMovie && item.year ? `${baseQuery} ${item.year}` : baseQuery;
    console.log(`=== ${item.title} (${item.year}, ${item.content_type}) — query: "${query}" ===`);

    const results = await tpbSearch(query);
    console.log(`  TPB results: ${results.length}`);

    if (results.length === 0) {
      stillNothing++;
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    let options = results.map(toOption).filter((o) => !isJunk(o.title) && hasVideoSignal(o.title));
    // Movies: a single reliable production year in the filename is the
    // strongest signal against a same-titled but different-year work
    // (confirmed false positives: "The Patriot" 1928 vs the 2000 Mel Gibson
    // film, "One Night of Love" matching unrelated music). TV episodes don't
    // reliably carry the show's original air year, so skip this for tv.
    if (isMovie && item.year) {
      options = options.filter((o) => o.title.includes(String(item.year)));
    }
    const p1080 = options.filter((o) => /1080p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const p720 = options.filter((o) => /720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);
    const other = options.filter((o) => !/1080p/i.test(o.title) && !/720p/i.test(o.title)).sort((a, b) => b.seeders - a.seeders);

    const new1080 = (p1080.length ? p1080 : other).slice(0, 10);
    const new720 = p720.slice(0, 10);

    if (new1080.length === 0 && new720.length === 0) {
      console.log("  ⚠ only junk-quality/no-seeder results, skipping");
      stillNothing++;
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    saveItemUpdate(item.id, {
      torrent_options: new1080,
      torrent_options_720p: new720,
      current_torrent_index: 0,
      current_torrent_index_720p: 0,
    });
    console.log(`  ✓ ${new1080.length} primary + ${new720.length} 720p option(s)`);
    if (new1080[0]) console.log(`    best: ${new1080[0].title} (${new1080[0].seeders} seeders)`);
    found++;

    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\nDone. ${found} found, ${stillNothing} still nothing.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
