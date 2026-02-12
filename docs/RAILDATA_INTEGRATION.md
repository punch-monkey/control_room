# Rail Data Integration

This project already supports:

- Darwin LDBWS board/service lookups via `/nre/*`
- Signalbox API via `/signalbox/*`

This document adds Rail Data Marketplace static feed integration via:

- `/raildata/health`
- `/raildata/kb/<feed>`

## 1) Configure credentials

Copy `.env.example` to `.env` and set either:

- `RAILDATA_AUTH_TOKEN` directly, or
- `RAILDATA_USERNAME` + `RAILDATA_PASSWORD`

Then start:

```powershell
python scripts/dev_server.py
```

## 2) Check health

Open:

- `http://localhost:8000/raildata/health`

You should see `configured: true` and supported `kb_feeds`.

## 3) Pull a feed

Examples:

- `http://localhost:8000/raildata/kb/incidents`
- `http://localhost:8000/raildata/kb/stations`
- `http://localhost:8000/raildata/kb/tocs`

Supported feed keys:

- `stations`
- `tocs`
- `incidents`
- `service-indicators`
- `ticket-restrictions`
- `ticket-types`
- `promotions-public`
- `routeing`

## 3.1) Full subscription coverage (your products)

For products whose exact endpoint path varies by subscription, paste URLs from
Rail Data "My Feeds" into `.env`:

- `RAILDATA_DISRUPTIONS_URL`
- `RAILDATA_NWR_PERFORMANCE_URL`
- `RAILDATA_NWR_PERFORMANCE_REFERENCE_URL`
- `RAILDATA_REFERENCE_DATA_URL`
- `RAILDATA_NAPTAN_URL`
- `RAILDATA_NPTG_URL`

Then use these proxy routes in the app:

- `/raildata/disruptions`
- `/raildata/performance`
- `/raildata/performance/reference`
- `/raildata/reference`
- `/raildata/service-details?serviceid=<serviceid>`
- `/raildata/live-board?crs=<crs>`
- `/raildata/naptan`
- `/raildata/nptg`

You can also call any feed directly:

- `/raildata/proxy?url=<full-feed-url>&auth=token`

## 4) Recommended app integration pattern

To avoid frontend bloat and runtime latency:

1. Pull upstream feeds server-side via `/raildata/kb/*`.
2. Build compact local summaries (JSON) under `data/`.
3. Load only summary JSON in browser (same model as `dvla_vehicle_icon_lookup.json`).

This keeps credentials server-side and keeps GitHub repository size stable.

## 5) Automated preview run

Run:

```powershell
python scripts/preview_raildata_feeds.py --crs KGX
```

Outputs are written to:

- `data/raildata_previews/<timestamp>/summary.json`
- `data/raildata_previews/<timestamp>/report.md`
- `data/raildata_previews/<timestamp>/*` (sample response bodies)
- `data/raildata_previews/latest.json`

Notes:

- The preview tool supports per-feed keys (e.g. `RAILDATA_TOC_API_KEY`, `RAILDATA_NAPTAN_API_KEY`).
- If a feed returns `401 Invalid ApiKey for given resource`, that product needs its own key in `.env`.
