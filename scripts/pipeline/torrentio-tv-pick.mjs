#!/usr/bin/env node
/**
 * One-off: search Torrentio for the 37 TV shows that have no magnet.
 * Uses the series endpoint (S01E01 probe) to find season packs / episodes.
 * Writes results as a sidecar JSON (list of {id, torrent_options[_720p]}).
 * Does NOT touch enriched_400.json — the pipeline will merge the sidecar
 * on next pick phase, or we merge manually when the pipeline is stopped.
 */
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "backend/data");
const ENRICHED_FILE = path.join(DATA_DIR, "enriched_400.json");
const OUT_FILE = path.join(DATA_DIR, "torrentio-tv-sidecar.json");

// Default config (not brazuca — these are mostly international shows)
const TORRENTIO_BASE = "https://torrentio.strem.fun/stream";
const TORRENTIO_BR = "https://torrentio.strem.fun/brazuca/stream";

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
  return {
    title: meta.title,
    magnet: buildMagnet(s.infoHash, meta.title),
    seeders: meta.seeders,
    size: meta.size,
    provider: "Torrentio",
  };
}

async function fetchStreams(imdbId, base) {
  const url = `${base}/series/${imdbId}:1:1.json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json.streams || [];
    } catch (e) {
      if (attempt === 3) return null;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const items = data.items || data;

  const nothings = items.filter(i => {
    const s = Boolean(i.s3_key || (i.s3_keys && i.s3_keys.length) || i.hls_playlist_s3_key);
    return !s && !i.acquisition_exhausted && !i.torrent_options && !i.torrent_options_720p && !i.torrent_file;
  });

  console.log(`Searching Torrentio for ${nothings.length} TV shows...\n`);

  const picks = [];
  for (const item of nothings) {
    // Try default first, then brazuca for BR content
    const isBR = /[áàâãéêíóôõúç]/i.test(item.title) || item.id.includes('brasil') ||
      ['roque-santeiro','vale-tudo','tieta','sai-de-baixo','lacos-de-familia','mulheres-apaixonadas',
       'o-rei-do-gado','os-trapalhoes','cordel-encantado','toma-la','todas-as-flores','cangaco-novo',
       'tapas-beijos','terra-nostra','explode-coracao','pe-na-cova','masterchef-brasil','coisa-mais-linda',
       'rancho-fundo','the-voice-brasil','no-limite','big-brother-brasil','a-fazenda','escolinha-do-professor',
       'city-of-men'].some(k => item.id.includes(k));

    const streams = await fetchStreams(item.imdb_id, TORRENTIO_BASE);
    let brStreams = null;
    if (isBR) {
      brStreams = await fetchStreams(item.imdb_id, TORRENTIO_BR);
    }

    const all = [...(streams || []), ...(brStreams || [])];
    // Deduplicate by infoHash
    const seen = new Set();
    const deduped = all.filter(s => {
      if (seen.has(s.infoHash)) return false;
      seen.add(s.infoHash);
      return true;
    });

    if (deduped.length === 0) {
      console.log(`  ✗ ${item.title} (${item.year}) — no streams`);
      continue;
    }

    const options = deduped.map(toOption);
    // Separate by quality
    const p1080 = options.filter(o => /1080p/i.test(o.title));
    const p720 = options.filter(o => /720p/i.test(o.title));

    // Filter out obvious junk (CAM, TS, etc)
    const isJunk = (t) => /\b(CAM|TS|TC|SCREENER|R5)\b/i.test(t);
    const good1080 = p1080.filter(o => !isJunk(o.title)).sort((a,b) => b.seeders - a.seeders);
    const good720 = p720.filter(o => !isJunk(o.title)).sort((a,b) => b.seeders - a.seeders);
    const goodAny = options.filter(o => !isJunk(o.title)).sort((a,b) => b.seeders - a.seeders);

    const pick = {
      id: item.id,
      title: item.title,
      year: item.year,
      imdb_id: item.imdb_id,
      total_streams: deduped.length,
    };

    if (good720.length > 0) pick.torrent_options_720p = good720.slice(0, 10);
    if (good1080.length > 0) pick.torrent_options = good1080.slice(0, 10);
    if (!pick.torrent_options_720p && !pick.torrent_options && goodAny.length > 0) {
      pick.torrent_options_720p = goodAny.slice(0, 10); // fallback to best available
    }

    if (pick.torrent_options || pick.torrent_options_720p) {
      picks.push(pick);
      const q = pick.torrent_options ? '1080p' : (pick.torrent_options_720p ? '720p' : '?');
      console.log(`  ✓ ${item.title} (${item.year}) — ${deduped.length} streams, picked ${q}`);
    } else {
      console.log(`  ✗ ${item.title} (${item.year}) — ${deduped.length} streams but all junk`);
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(picks, null, 2));
  console.log(`\n${picks.length}/${nothings.length} TV shows got magnets → ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
