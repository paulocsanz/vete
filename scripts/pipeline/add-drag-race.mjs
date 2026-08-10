#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ENRICHED_FILE = path.join(process.cwd(), "backend/data/enriched_400.json");
const TORRENTIO_BASE = "https://torrentio.strem.fun/stream";
const BR = "https://torrentio.strem.fun/brazuca/stream";

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
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.streams || [];
  } catch (e) {
    console.log("  Error:", e.message);
    return null;
  }
}

async function main() {
  const shows = [
    {
      title: "RuPaul's Drag Race Brasil",
      title_pt: "RuPaul's Drag Race Brasil",
      year: 2021,
      id: "rupauls-drag-race-brasil-2021-tv",
      imdb_id: "tt24251630",
      creator: "RuPaul",
      genres: ["Reality-TV"],
      genres_pt: ["Reality"],
      rated: "TV-MA",
      rated_pt: "14",
      origin: "Brazilian",
      plot: "Brazilian version of the hit drag queen competition show hosted by RuPaul and judge Gretchen.",
      plot_pt: "Versão brasileira do reality show de drag queens apresentado por RuPaul com a judge Gretchen.",
    },
    {
      title: "RuPaul's Drag Race All Stars",
      title_pt: "RuPaul's Drag Race All Stars",
      year: 2012,
      id: "rupauls-drag-race-all-stars-2012-tv",
      imdb_id: "tt2301351",
      creator: "RuPaul",
      genres: ["Reality-TV", "Game-Show"],
      genres_pt: ["Reality"],
      rated: "TV-MA",
      rated_pt: "14",
      origin: "International",
      plot: "Past contestants from RuPaul's Drag Race return to compete for a spot in the Drag Race Hall of Fame.",
      plot_pt: "Ex-participantes de RuPaul's Drag Race retornam para competir por um lugar no Hall da Fama.",
    },
  ];

  for (const show of shows) {
    console.log(`\n=== ${show.title} (${show.year}) ===`);

    // Fetch poster/backdrop from OMDB or IMDB
    // Use known IMDB poster URLs
    let poster_url = null;
    let backdrop_url = null;

    // Fetch from TMDB-style API (using OMDB as fallback)
    try {
      const omdbKey = (process.env.OMDB_API_KEYS || "").split(",")[0];
      const omdbRes = await fetch(`https://www.omdbapi.com/?i=${show.imdb_id}&apikey=${omdbKey}`);
      if (omdbRes.ok) {
        const omdb = await omdbRes.json();
        if (omdb.Poster && omdb.Poster !== "N/A") poster_url = omdb.Poster;
        if (omdb.imdbRating && omdb.imdbRating !== "N/A") show.imdb_rating = parseFloat(omdb.imdbRating);
        if (omdb.imdbVotes && omdb.imdbVotes !== "N/A") show.imdb_votes = omdb.imdbVotes;
        if (omdb.Runtime && omdb.Runtime !== "N/A") show.runtime = omdb.Runtime;
        if (omdb.Actors && omdb.Actors !== "N/A") show.actors = omdb.Actors.split(", ");
        if (omdb.Plot && omdb.Plot !== "N/A") {
          show.plot = omdb.Plot;
        }
      }
    } catch (e) {
      console.log("  OMDB fetch failed:", e.message);
    }

    // Search Torrentio
    const streams = await fetchStreams(show.imdb_id, TORRENTIO_BASE);
    const brStreams = await fetchStreams(show.imdb_id, BR);
    const all = [...(streams || []), ...(brStreams || [])];
    const seen = new Set();
    const deduped = all.filter((s) => {
      if (seen.has(s.infoHash)) return false;
      seen.add(s.infoHash);
      return true;
    });

    console.log(`  Streams found: ${deduped.length}`);

    const options = deduped.map(toOption);
    const p1080 = options.filter((o) => /1080p/i.test(o.title));
    const p720 = options.filter((o) => /720p/i.test(o.title));
    const isJunk = (t) => /\b(CAM|TS|TC|SCREENER|R5)\b/i.test(t);

    show.torrent_options = p1080.filter((o) => !isJunk(o.title)).sort((a, b) => b.seeders - a.seeders).slice(0, 10);
    show.torrent_options_720p = p720.filter((o) => !isJunk(o.title)).sort((a, b) => b.seeders - a.seeders).slice(0, 10);

    // Fallback: if no quality-tagged, use best available
    if (show.torrent_options.length === 0 && show.torrent_options_720p.length === 0) {
      const good = options.filter((o) => !isJunk(o.title)).sort((a, b) => b.seeders - a.seeders).slice(0, 10);
      show.torrent_options_720p = good;
    }

    console.log(`  1080p options: ${show.torrent_options.length}`);
    console.log(`  720p options: ${show.torrent_options_720p.length}`);
    if (show.torrent_options.length > 0) console.log("  Best 1080p:", show.torrent_options[0].title, `(${show.torrent_options[0].seeders} seeders)`);
    if (show.torrent_options_720p.length > 0) console.log("  Best 720p:", show.torrent_options_720p[0].title, `(${show.torrent_options_720p[0].seeders} seeders)`);
  }

  // Add to enriched_400.json
  const data = JSON.parse(fs.readFileSync(ENRICHED_FILE, "utf-8"));
  const items = data.items || data;

  for (const show of shows) {
    const existing = items.find((i) => i.id === show.id);
    if (existing) {
      console.log(`\nUpdating existing ${show.title}`);
      Object.assign(existing, show);
    } else {
      console.log(`\nAdding new ${show.title}`);
      const newItem = {
        ...show,
        content_type: "tv",
        original_title: null,
        director: null,
        curated_imdb_rating: show.imdb_rating ?? 0,
        poster_url: show.poster_url || null,
        backdrop_url: show.backdrop_url || null,
        actors: show.actors || [],
        awards: null,
        tmdb_id: null,
        collection_id: null,
        collection_name: null,
        trailer_key: null,
        enrichment_status: "ok",
        s3_key: null,
        s3_keys: [],
        subtitles: [],
        episodes: [],
        keywords: [],
        award_entries: [],
        trailer_s3_key: null,
        trailer_subtitles: [],
        attachments: [],
        poster_s3_key: null,
        encrypted: false,
        media_codecs: null,
        current_torrent_index: 0,
        current_torrent_index_720p: 0,
      };
      items.push(newItem);
    }
  }

  const out = data.items ? { ...data, items } : { items };
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(out, null, 2));
  console.log("\nSaved to enriched_400.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
