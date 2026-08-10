#!/usr/bin/env node
/**
 * Fetch subtitles for the final 11 titles with zero coverage.
 * Uses ACTUAL content (from S3 filenames) rather than catalog metadata,
 * since many entries have mismatched IMDB IDs / titles.
 *
 * Strategy per title:
 *   1. OpenSubtitles REST API (by real IMDB ID or query)
 *   2. SubDL (by real title)
 *   3. Yifysubtitles (for movies)
 *
 * Usage:
 *   node scripts/pipeline/fetch-remaining-subtitles.mjs
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const BACKFILL_PATH = path.join(ROOT, "backend", "data", "subtitle_backfill.json");

const API_KEY = process.env.OPENSUBTITLES_API_KEY;
const OS_USERNAME = process.env.OPENSUBTITLES_USERNAME;
const OS_PASSWORD = process.env.OPENSUBTITLES_PASSWORD;
const OS_USER_AGENT = process.env.OPENSUBTITLES_USER_AGENT || "tv-platform v1.0";

let cachedToken = process.env.OPENSUBTITLES_TOKEN || null;
async function getToken() {
  if (cachedToken) return cachedToken;
  if (!OS_USERNAME || !OS_PASSWORD) return null;
  const res = await fetch("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    headers: {
      "Api-Key": API_KEY,
      "User-Agent": OS_USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: OS_USERNAME, password: OS_PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(`OS login failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  cachedToken = data.token;
  return cachedToken;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_LANGS = ["eng", "por", "spa"];

const LANG_IETF = { eng: "en", por: "pt-br", spa: "es" };
const LANG_LABEL = { eng: "English", por: "Português", spa: "Español" };
const YIFY_LANG = {
  eng: ["english"],
  por: ["brazilian-portuguese", "brazilian", "portuguese"],
  spa: ["spanish"],
};

// Titles with their REAL content info (derived from S3 filenames)
const TARGETS = [
  {
    id: "phoenix-1992-tv",
    realTitle: "Dark Phoenix",
    realImdb: "tt6565702",
    type: "movie",
    episode: 0,
  },
  {
    id: "popstar-2002-tv",
    realTitle: "Popstar: Never Stop Never Stopping",
    realImdb: "tt2068699",
    type: "movie",
    episode: 0,
  },
  {
    id: "justice-league-unlimited-2004-tv",
    realTitle: "Young Justice",
    realImdb: "tt1641384",
    type: "tv",
    episodes: 20, // S02 E01-E20
    season: 2,
  },
  {
    id: "crash-landing-on-you-2019-tv",
    realTitle: "Project Hail Mary",
    realImdb: null, // 2026 movie, may not be in IMDB yet
    type: "movie",
    episode: 0,
    searchQuery: "Project Hail Mary 2026",
  },
  {
    id: "i-claudius-1976-tv",
    realTitle: "I Claudius",
    realImdb: "tt0074006",
    type: "tv",
    episodes: 13,
    season: 1,
  },
  {
    id: "my-mom-is-a-character-2-2016-movie",
    realTitle: "Minha Mae e uma Peca 2",
    realImdb: "tt3212812",
    type: "movie",
    episode: 0,
  },
  {
    id: "my-mom-is-a-character-3-2019-movie",
    realTitle: "Minha Mae e uma Peca 3",
    realImdb: "tt10611372",
    type: "movie",
    episode: 0,
  },
  {
    id: "s-o-s-women-to-the-sea-2-2015-movie",
    realTitle: "S.O.S. Women to the Sea",
    realImdb: "tt4358196",
    type: "movie",
    episode: 0,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackfill() {
  try {
    return JSON.parse(fs.readFileSync(BACKFILL_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveBackfill(data) {
  const sorted = Object.fromEntries(
    Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(BACKFILL_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

function extractSubFromZip(buf) {
  // Parse ZIP central directory
  if (buf.length < 22) throw new Error("ZIP too small");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD not found");

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let offset = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const fileNameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeader = buf.readUInt32LE(offset + 42);
    const fname = buf.slice(offset + 46, offset + 46 + fileNameLen).toString("utf8");

    if (/\.(srt|vtt|ssa|ass|sub)$/i.test(fname)) {
      const lhNameLen = buf.readUInt16LE(localHeader + 26);
      const lhExtraLen = buf.readUInt16LE(localHeader + 28);
      const dataStart = localHeader + 30 + lhNameLen + lhExtraLen;
      const compData = buf.slice(dataStart, dataStart + compSize);
      const raw = method === 0 ? compData : zlib.inflateRawSync(compData);
      return { filename: fname, content: raw };
    }
    offset += 46 + fileNameLen + extraLen + commentLen;
  }
  throw new Error("ZIP: no subtitle file found");
}

function srtToVtt(srtContent) {
  let text = srtContent.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Remove BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Convert timestamps
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  // Add WEBVTT header
  text = "WEBVTT\n\n" + text;
  // Remove sequential numbers (optional but cleaner)
  text = text.replace(/^\d+\s*$/gm, "");
  // Clean up double blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  return Buffer.from(text, "utf8");
}

function ssaToVtt(ssaContent) {
  let text = ssaContent.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events = text.split("\n").filter((l) => l.startsWith("Dialogue:"));
  let vtt = "WEBVTT\n\n";
  let idx = 1;
  for (const line of events) {
    const parts = line.substring(line.indexOf(":") + 1).split(",");
    if (parts.length < 10) continue;
    const start = parts[1].trim().replace(",", ".");
    const end = parts[2].trim().replace(",", ".");
    let dialog = parts.slice(9).join(",").trim();
    // Clean SSA tags
    dialog = dialog.replace(/\{[^}]*\}/g, "");
    dialog = dialog.replace(/\\N/g, "\n");
    if (!dialog) continue;
    const fmtT = (t) => {
      const m = t.match(/(\d+):(\d+):(\d+):(\d+)/);
      if (m) return `${m[1].padStart(2,"0")}:${m[2].padStart(2,"0")}:${m[3].padStart(2,"0")}.${m[4].padStart(3,"0")}`;
      return t;
    };
    vtt += `${fmtT(start)} --> ${fmtT(end)}\n${dialog}\n\n`;
  }
  return Buffer.from(vtt, "utf8");
}

function subToVtt(content) {
  if (content.length > 2 && content[0] === 0x57 && content[1] === 0x45) return content; // Already WEBVTT
  const text = content.toString("utf8");
  if (text.includes("[Events]") && text.includes("Dialogue:")) return ssaToVtt(content);
  return srtToVtt(content);
}

let s3Client;
function getS3() {
  if (s3Client) return s3Client;
  const { accessKeyId, secretAccessKey, bucketName, endpoint, region, urlStyle } = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (!accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
    throw new Error("Missing S3_* env — source .env.caixote first");
  }
  s3Client = { bucketName, accessKeyId, secretAccessKey, endpoint, region, urlStyle };
  return s3Client;
}

async function uploadToS3(key, buffer) {
  const creds = getS3();
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: creds.urlStyle !== "virtual-host",
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: creds.bucketName,
      Key: key,
      Body: buffer,
      ContentType: "text/vtt",
    })
  );
}

// ─── OpenSubtitles ───────────────────────────────────────────────────────────

async function osFetch(pathname, opts = {}) {
  const headers = {
    "Api-Key": API_KEY,
    "User-Agent": "tv-platform v1.0",
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const url = `https://api.opensubtitles.com/api/v1${pathname}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OS ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function osSearchByImdb(imdbId, langs, episodeOpt) {
  const langStr = langs.map((l) => LANG_IETF[l]).join(",");
  const params = new URLSearchParams({
    imdb_id: imdbId.replace("tt", ""),
    languages: langStr,
  });
  if (episodeOpt?.season) params.set("season_number", episodeOpt.season);
  if (episodeOpt?.episode) params.set("episode_number", episodeOpt.episode);

  const data = await osFetch(`/subtitles?${params}`, { token: await getToken() });
  return data.data || [];
}

async function osSearchByQuery(query, langs) {
  const langStr = langs.map((l) => LANG_IETF[l]).join(",");
  const params = new URLSearchParams({ query, languages: langStr });
  const data = await osFetch(`/subtitles?${params}`, { token: await getToken() });
  return data.data || [];
}

async function osDownload(fileId, destPath, legacySubId) {
  try {
    const data = await osFetch("/download", {
      method: "POST",
      body: { file_id: fileId },
      token: await getToken(),
    });
    const link = data.link;
    const res = await fetch(link);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let subContent;
    try {
      const extracted = extractSubFromZip(buf);
      subContent = subToVtt(extracted.content);
    } catch {
      subContent = subToVtt(buf);
    }
    await uploadToS3(destPath, subContent);
    return true;
  } catch (e) {
    if (!legacySubId || !/401|missing token|quota/i.test(e.message)) throw e;
    // Legacy fallback
    const legacyUrl = `https://dl.opensubtitles.org/en/download/sub/${legacySubId}`;
    const res = await fetch(legacyUrl, {
      headers: { "User-Agent": "tv-platform v1.0" },
    });
    if (!res.ok) throw new Error(`legacy ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const extracted = extractSubFromZip(buf);
    const subContent = subToVtt(extracted.content);
    await uploadToS3(destPath, subContent);
    return true;
  }
}

function pickBestPerLang(results, targetLangs, episodeOpt) {
  const byLang = {};
  for (const item of results) {
    for (const f of item.attributes?.files || []) {
      const langCode = item.attributes?.language || "";
      const langName = item.attributes?.language || "";
      // Map IETF back to our codes
      let ourLang = null;
      if (langCode.startsWith("en")) ourLang = "eng";
      else if (langCode.startsWith("pt")) ourLang = "por";
      else if (langCode.startsWith("es")) ourLang = "spa";

      if (!ourLang || !targetLangs.includes(ourLang)) continue;

      if (!byLang[ourLang]) {
        byLang[ourLang] = {
          fileId: f.file_id,
          legacySubId: item.attributes?.legacy_feature_id || f.file_id,
          release: f.file_name || item.attributes?.release,
          ratings: item.attributes?.ratings || 0,
          downloads: item.attributes?.download_count || 0,
        };
      }
    }
  }
  return byLang;
}

// ─── SubDL (official API: https://subdl.com/api-doc) ─────────────────────────

const SUBDL_API_KEY = process.env.SUBDL_API_KEY;
const SUBDL_LANG_CODE = { eng: "EN", por: "PT_BR", spa: "ES" };

async function subdlFetch(target, langs) {
  if (!SUBDL_API_KEY) return [];
  const params = new URLSearchParams({
    api_key: SUBDL_API_KEY,
    languages: langs.map((l) => SUBDL_LANG_CODE[l]).join(","),
    unpack: "1",
    type: target.type,
  });
  if (target.realImdb) params.set("imdb_id", target.realImdb);
  else params.set("film_name", target.searchQuery || target.realTitle);
  if (target.type === "tv") params.set("full_season", "1");

  const res = await fetch(`https://api.subdl.com/api/v1/subtitles?${params}`);
  const data = await res.json();
  if (!data.status) return [];
  return data.subtitles || [];
}

async function subdlDownloadDirect(url, destPath) {
  const fullUrl = url.startsWith("http") ? url : `https://dl.subdl.com${url}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(fullUrl);
      if (res.status === 429) {
        const wait = 10000 * (attempt + 1);
        console.log(`    429, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`subdl dl ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      let subContent;
      try {
        const extracted = extractSubFromZip(buf);
        subContent = subToVtt(extracted.content);
      } catch {
        subContent = subToVtt(buf); // direct .srt, not a zip
      }
      await uploadToS3(destPath, subContent);
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(3000);
    }
  }
  throw lastErr;
}

// ─── Yifysubtitles ───────────────────────────────────────────────────────────

async function yifyFetchLinks(imdbId, targetLangs) {
  const url = `https://yifysubtitles.ch/movie-imdb/${imdbId}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return { cookie: "", byLang: {} };

  // Get cookie
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];

  const html = await res.text();
  const byLang = {};

  for (const lang of targetLangs) {
    const slugs = YIFY_LANG[lang] || [];
    for (const slug of slugs) {
      const regex = new RegExp(
        `<tr[^>]*>.*?/subtitles/${slug}[^"]*".*?<a[^>]*href="(/subtitle/[^"]+\\.zip)"`,
        "is"
      );
      const m = html.match(regex);
      if (m) {
        byLang[lang] = `https://yifysubtitles.ch${m[1]}`;
        break;
      }
      // Try simpler pattern
      const simpleRegex = new RegExp(
        `href="(/subtitle/[^"]*${slug}[^"]*\\.zip)"`,
        "i"
      );
      const sm = html.match(simpleRegex);
      if (sm) {
        byLang[lang] = `https://yifysubtitles.ch${sm[1]}`;
        break;
      }
    }
  }

  return { cookie, byLang };
}

async function yifyDownload(zipUrl, cookie, destPath) {
  const res = await fetch(zipUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://yifysubtitles.ch",
      Cookie: cookie,
    },
  });
  if (!res.ok) throw new Error(`yify ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const extracted = extractSubFromZip(buf);
  const subContent = subToVtt(extracted.content);
  await uploadToS3(destPath, subContent);
  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const backfill = loadBackfill();
  let totalUploaded = 0;
  let totalUpdated = 0;

  for (const target of TARGETS) {
    const id = target.id;
    const existing = backfill[id]?.subtitles || [];
    const existingLangs = new Set(existing.map((s) => s.id));
    const missingLangs = TARGET_LANGS.filter((l) => !existingLangs.has(l));

    if (missingLangs.length === 0) {
      console.log(`[${target.realTitle}] already has all langs, skip`);
      continue;
    }

    console.log(`\n=== ${target.realTitle} (${id}) ===`);
    console.log(`  missing: ${missingLangs.join(",")}`);
    console.log(`  imdb: ${target.realImdb || "none"}, type: ${target.type}`);

    let foundThisTitle = false;

    // ── Strategy 1: OpenSubtitles by IMDB ──
    if (target.realImdb && API_KEY) {
      try {
        if (target.type === "movie") {
          const results = await osSearchByImdb(target.realImdb, missingLangs);
          if (results.length > 0) {
            console.log(`  OS: ${results.length} results`);
            const picks = pickBestPerLang(results, missingLangs);
            for (const [lang, pick] of Object.entries(picks)) {
              const s3Key = `videos/${id}/external.0.${lang}.vtt`;
              try {
                await osDownload(pick.fileId, s3Key, pick.legacySubId);
                console.log(`    [OS ${lang}] ✓ uploaded`);
                if (!backfill[id]) backfill[id] = { subtitles: [] };
                backfill[id].subtitles.push({
                  episode: 0,
                  id: lang,
                  lang,
                  label: LANG_LABEL[lang],
                  forced: false,
                  s3_key: s3Key,
                });
                totalUploaded++;
                foundThisTitle = true;
              } catch (e) {
                console.log(`    [OS ${lang}] ✗ ${e.message}`);
              }
              await sleep(1000);
            }
          }
        } else {
          // TV: search per episode
          const epCount = target.episodes || 1;
          for (let ep = 1; ep <= epCount; ep++) {
            try {
              const results = await osSearchByImdb(target.realImdb, missingLangs, {
                season: target.season || 1,
                episode: ep,
              });
              if (results.length === 0) continue;
              const picks = pickBestPerLang(results, missingLangs);
              for (const [lang, pick] of Object.entries(picks)) {
                const s3Key = `videos/${id}/external.${ep}.${lang}.vtt`;
                const already = (backfill[id]?.subtitles || []).some(
                  (s) => s.s3_key === s3Key
                );
                if (already) continue;
                try {
                  await osDownload(pick.fileId, s3Key, pick.legacySubId);
                  console.log(`    [OS ep${ep} ${lang}] ✓ uploaded`);
                  if (!backfill[id]) backfill[id] = { subtitles: [] };
                  backfill[id].subtitles.push({
                    episode: ep,
                    id: lang,
                    lang,
                    label: LANG_LABEL[lang],
                    forced: false,
                    s3_key: s3Key,
                  });
                  totalUploaded++;
                  foundThisTitle = true;
                } catch (e) {
                  console.log(`    [OS ep${ep} ${lang}] ✗ ${e.message}`);
                }
                await sleep(1000);
              }
            } catch (e) {
              // continue to next ep
            }
          }
        }
      } catch (e) {
        console.log(`  OS error: ${e.message}`);
      }
    }

    // Re-check what's still missing
    const stillMissing = missingLangs.filter((lang) => {
      const hasIt = (backfill[id]?.subtitles || []).some((s) => s.id === lang);
      return !hasIt;
    });

    if (stillMissing.length === 0) {
      console.log(`  ✓ ${target.realTitle} complete!`);
      totalUpdated++;
      saveBackfill(backfill);
      continue;
    }

    // ── Strategy 2: SubDL (official API) ──
    console.log(`  SubDL: searching for "${target.realTitle}"...`);
    try {
      const releases = await subdlFetch(target, stillMissing);
      if (releases.length === 0) {
        console.log(`  SubDL: not found`);
      } else {
        console.log(`  SubDL: ${releases.length} release(s) found`);
        for (const lang of stillMissing) {
          const wantCode = SUBDL_LANG_CODE[lang];
          const files = releases.flatMap((r) =>
            (r.unpack_files || []).filter((f) => f.language === wantCode)
          );
          if (files.length === 0) continue;

          if (target.type === "movie") {
            const f = files[0];
            const s3Key = `videos/${id}/subdl.0.${lang}.vtt`;
            try {
              await subdlDownloadDirect(f.url, s3Key);
              console.log(`    [SubDL ${lang}] ✓ uploaded`);
              if (!backfill[id]) backfill[id] = { subtitles: [] };
              backfill[id].subtitles.push({
                episode: 0,
                id: lang,
                lang,
                label: LANG_LABEL[lang],
                forced: false,
                s3_key: s3Key,
              });
              totalUploaded++;
              foundThisTitle = true;
            } catch (e) {
              console.log(`    [SubDL ${lang}] ✗ ${e.message}`);
            }
          } else {
            // TV: merge per-episode files across every release found, first hit wins
            const byEpisode = new Map();
            for (const f of files) {
              const ep = f.episode;
              if (!ep || ep < 1 || (target.episodes && ep > target.episodes)) continue;
              if (!byEpisode.has(ep)) byEpisode.set(ep, f);
            }
            for (const [ep, f] of [...byEpisode.entries()].sort((a, b) => a[0] - b[0])) {
              const s3Key = `videos/${id}/subdl.${ep}.${lang}.vtt`;
              const already = (backfill[id]?.subtitles || []).some((s) => s.s3_key === s3Key);
              if (already) continue;
              try {
                await subdlDownloadDirect(f.url, s3Key);
                console.log(`    [SubDL ep${ep} ${lang}] ✓ uploaded`);
                if (!backfill[id]) backfill[id] = { subtitles: [] };
                backfill[id].subtitles.push({
                  episode: ep,
                  id: lang,
                  lang,
                  label: LANG_LABEL[lang],
                  forced: false,
                  s3_key: s3Key,
                });
                totalUploaded++;
                foundThisTitle = true;
              } catch (e) {
                console.log(`    [SubDL ep${ep} ${lang}] ✗ ${e.message}`);
              }
              await sleep(1500);
            }
          }
          await sleep(1000);
        }
      }
    } catch (e) {
      console.log(`  SubDL error: ${e.message}`);
    }

    // Re-check
    const stillMissing2 = missingLangs.filter((lang) => {
      const hasIt = (backfill[id]?.subtitles || []).some((s) => s.id === lang);
      return !hasIt;
    });

    if (stillMissing2.length === 0) {
      console.log(`  ✓ ${target.realTitle} complete!`);
      totalUpdated++;
      saveBackfill(backfill);
      continue;
    }

    // ── Strategy 3: Yifysubtitles (movies only) ──
    if (target.type === "movie" && target.realImdb) {
      try {
        const { cookie, byLang } = await yifyFetchLinks(target.realImdb, stillMissing2);
        for (const [lang, zipUrl] of Object.entries(byLang)) {
          const s3Key = `videos/${id}/yify.${lang}.vtt`;
          try {
            await yifyDownload(zipUrl, cookie, s3Key);
            console.log(`    [Yify ${lang}] ✓ uploaded`);
            if (!backfill[id]) backfill[id] = { subtitles: [] };
            backfill[id].subtitles.push({
              episode: 0,
              id: lang,
              lang,
              label: LANG_LABEL[lang],
              forced: false,
              s3_key: s3Key,
            });
            totalUploaded++;
            foundThisTitle = true;
          } catch (e) {
            console.log(`    [Yify ${lang}] ✗ ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`  Yify error: ${e.message}`);
      }
    }

    // ── Strategy 4: OpenSubtitles by query (for titles without IMDB) ──
    const stillMissing3 = missingLangs.filter((lang) => {
      const hasIt = (backfill[id]?.subtitles || []).some((s) => s.id === lang);
      return !hasIt;
    });

    if (stillMissing3.length > 0 && API_KEY && !target.realImdb) {
      try {
        const results = await osSearchByQuery(
          target.searchQuery || target.realTitle,
          stillMissing3
        );
        if (results.length > 0) {
          console.log(`  OS query: ${results.length} results`);
          const picks = pickBestPerLang(results, stillMissing3);
          for (const [lang, pick] of Object.entries(picks)) {
            const s3Key = `videos/${id}/external.0.${lang}.vtt`;
            try {
              await osDownload(pick.fileId, s3Key, pick.legacySubId);
              console.log(`    [OS-query ${lang}] ✓ uploaded`);
              if (!backfill[id]) backfill[id] = { subtitles: [] };
              backfill[id].subtitles.push({
                episode: 0,
                id: lang,
                lang,
                label: LANG_LABEL[lang],
                forced: false,
                s3_key: s3Key,
              });
              totalUploaded++;
              foundThisTitle = true;
            } catch (e) {
              console.log(`    [OS-query ${lang}] ✗ ${e.message}`);
            }
          }
        }
      } catch (e) {
        console.log(`  OS query error: ${e.message}`);
      }
    }

    if (foundThisTitle) totalUpdated++;
    saveBackfill(backfill);
    await sleep(2000);
  }

  console.log(
    `\nDone. items_updated=${totalUpdated} tracks_uploaded=${totalUploaded} → ${BACKFILL_PATH}`
  );
  console.log("Restart the backend so apply_subtitle_backfill picks up new tracks.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
