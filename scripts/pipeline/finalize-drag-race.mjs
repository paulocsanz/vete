#!/usr/bin/env node
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

async function fetchTPB(query) {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const json = await res.json();
    return json.filter(t => t.info_hash !== "0000000000000000000000000000000000000000");
  } catch (e) {
    console.log("  TPB error:", e.message);
    return [];
  }
}

function toOption(t) {
  return {
    title: t.name,
    magnet: buildMagnet(t.info_hash, t.name),
    seeders: parseInt(t.seeders, 10),
    size: `${(parseInt(t.size, 10) / 1024 / 1024).toFixed(0)}MB`,
    provider: "ThePirateBay",
  };
}

async function main() {
  // Drag Race Brasil
  console.log("=== Drag Race Brasil ===");
  const drResults = await fetchTPB("drag race brasil");
  // Filter to only 1080p WEB/WEB-DL releases (skip XviD, HEVC x265 for size, CAM)
  const dr1080 = drResults
    .filter(t => /1080p/i.test(t.name) && !/x265|hevc/i.test(t.name) && !/CAM|TS|TC\b/i.test(t.name))
    .sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders))
    .map(toOption);

  const dr720 = drResults
    .filter(t => /720p/i.test(t.name) && !/CAM|TS|TC\b/i.test(t.name))
    .sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders))
    .map(toOption);

  console.log(`  1080p: ${dr1080.length} options`);
  console.log(`  720p: ${dr720.length} options`);
  if (dr1080.length > 0) console.log("  Best:", dr1080[0].title, `(${dr1080[0].seeders} seeders)`);
  if (dr720.length > 0) console.log("  Best 720p:", dr720[0].title, `(${dr720[0].seeders} seeders)`);

  // All Stars
  console.log("\n=== RuPaul's Drag Race All Stars ===");
  const asResults = await fetchTPB("rupauls drag race all stars");
  const as1080 = asResults
    .filter(t => /1080p/i.test(t.name) && !/x265|hevc/i.test(t.name) && !/CAM|TS|TC\b/i.test(t.name))
    .filter(t => !/untucked/i.test(t.name)) // skip untucked
    .sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders))
    .map(toOption);

  const as720 = asResults
    .filter(t => /720p/i.test(t.name) && !/CAM|TS|TC\b/i.test(t.name))
    .filter(t => !/untucked/i.test(t.name))
    .sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders))
    .map(toOption);

  console.log(`  1080p: ${as1080.length} options`);
  console.log(`  720p: ${as720.length} options`);
  if (as1080.length > 0) console.log("  Best:", as1080[0].title, `(${as1080[0].seeders} seeders)`);
  if (as720.length > 0) console.log("  Best 720p:", as720[0].title, `(${as720[0].seeders} seeders)`);

  // Update enriched_400.json
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const items = data.items || data;

  const dr = items.find(i => i.id === "rupauls-drag-race-brasil-2021-tv");
  if (dr) {
    dr.torrent_options = dr1080.slice(0, 10);
    dr.torrent_options_720p = dr720.slice(0, 10);
    dr.current_torrent_index = 0;
    dr.current_torrent_index_720p = 0;
    console.log("\n✓ Updated Drag Race Brasil with torrents");
  }

  const as = items.find(i => i.id === "rupauls-drag-race-all-stars-2012-tv");
  if (as) {
    as.torrent_options = as1080.slice(0, 10);
    as.torrent_options_720p = as720.slice(0, 10);
    as.current_torrent_index = 0;
    as.current_torrent_index_720p = 0;
    console.log("✓ Updated Drag Race All Stars with torrents");
  }

  const out = data.items ? data : { items };
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(out, null, 2));
  console.log("\nSaved.");
}

main().catch(e => { console.error(e); process.exit(1); });
