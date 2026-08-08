#!/usr/bin/env bash
# Continuous HLS-AES packager for the existing library (RFC 0009).
# Packages single-file titles first, then multi-episode series.
# Runs N titles concurrently (--concurrency) to use multiple CPU cores.
#
#   set -a && source .env.caixote && set +a
#   nohup ./scripts/pipeline/package-hls-worker.sh >> /tmp/package-hls-worker.log 2>&1 &
#
# Env:
#   MAX_TITLES     stop after N successes (default 0 = unlimited)
#   SLEEP_SEC      pause between batches (default 5)
#   INCLUDE_SERIES set to 1 to process multi-ep after singles are done (default 1)
#   CONCURRENCY    number of titles to package in parallel (default 4)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MAX_TITLES="${MAX_TITLES:-0}"
SLEEP_SEC="${SLEEP_SEC:-5}"
INCLUDE_SERIES="${INCLUDE_SERIES:-1}"
CONCURRENCY="${CONCURRENCY:-1}"
LOG_PREFIX="[hls-worker $(date +%H:%M:%S)]"

if [[ -z "${ENCRYPTION_CATALOG_KEY:-}" ]]; then
  echo "$LOG_PREFIX ENCRYPTION_CATALOG_KEY missing — source .env.caixote first"
  exit 1
fi
if [[ -z "${S3_ACCESS_KEY_ID:-}" ]]; then
  echo "$LOG_PREFIX S3 creds missing — source .env.caixote first"
  exit 1
fi

done_count=0
echo "$LOG_PREFIX start MAX_TITLES=${MAX_TITLES:-∞} INCLUDE_SERIES=$INCLUDE_SERIES CONCURRENCY=$CONCURRENCY"

while true; do
  # Count pending titles
  remaining="$(node -e '
    const d=require("./backend/data/enriched_400.json");
    const keys=x=>(x.s3_keys&&x.s3_keys.length)?x.s3_keys:(x.s3_key?[x.s3_key]:[]);
    console.log(d.items.filter(x=>x&&keys(x).length&&!x.hls_playlist_s3_key).length);
  ' 2>/dev/null || echo 0)"

  if [[ "$remaining" -eq 0 ]]; then
    echo "$LOG_PREFIX all titles with S3 media have HLS. exiting."
    exit 0
  fi

  # Apply MAX_TITLES as a --limit on this batch
  limit_arg=""
  if [[ "$MAX_TITLES" -gt 0 ]]; then
    remaining_budget=$(( MAX_TITLES - done_count ))
    if [[ "$remaining_budget" -le 0 ]]; then
      echo "$LOG_PREFIX hit MAX_TITLES=$MAX_TITLES — stop"
      exit 0
    fi
    limit_arg="--limit $remaining_budget"
  fi

  series_arg=""
  [[ "$INCLUDE_SERIES" == "1" ]] || series_arg="--include-series"

  echo "$LOG_PREFIX batch: $remaining pending, concurrency=$CONCURRENCY"

  # Snapshot HLS count before batch
  before="$(node -e '
    const idx = require("./lib/hls-catalog-index.cjs");
    console.log(Object.keys(idx.loadHlsIndex()).length);
  ' 2>/dev/null || echo 0)"

  # Run one batch — JS handles concurrency internally, output streams live
  node scripts/pipeline/package-hls-from-s3.js --all $limit_arg $series_arg --concurrency "$CONCURRENCY" 2>&1
  batch_exit=$?

  # Count new HLS titles after batch
  after="$(node -e '
    const idx = require("./lib/hls-catalog-index.cjs");
    console.log(Object.keys(idx.loadHlsIndex()).length);
  ' 2>/dev/null || echo 0)"
  batch_count=$((after - before))
  done_count=$after

  echo "$LOG_PREFIX batch done (exit $batch_exit) — +${batch_count} new, HLS total: $done_count"

  if [[ "$MAX_TITLES" -gt 0 && "$done_count" -ge "$MAX_TITLES" ]]; then
    echo "$LOG_PREFIX hit MAX_TITLES=$MAX_TITLES — stop"
    exit 0
  fi

  # If the batch made no progress (all failed or skipped), back off
  if [[ "$batch_count" -eq 0 ]]; then
    echo "$LOG_PREFIX no progress this batch — sleep ${SLEEP_SEC}s"
    sleep "$SLEEP_SEC"
  fi
done
