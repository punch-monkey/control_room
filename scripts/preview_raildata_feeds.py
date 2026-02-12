import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import quote_plus

import requests


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
OUT_DIR = ROOT / "data" / "raildata_previews"

MAX_BODY_BYTES = 250_000
TIMEOUT_SECONDS = 35


def load_dotenv(path: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def render_template(url: str, values: Dict[str, str]) -> Tuple[str, List[str]]:
    out = str(url or "")
    needed = re.findall(r"\{([A-Za-z0-9_]+)\}", out)
    missing: List[str] = []
    for key in needed:
        value = str(values.get(key, "")).strip()
        if not value:
            missing.append(key)
            continue
        out = out.replace("{" + key + "}", quote_plus(value))
    return out, missing


def content_ext(content_type: str) -> str:
    ct = (content_type or "").lower()
    if "json" in ct:
        return "json"
    if "xml" in ct:
        return "xml"
    if "html" in ct:
        return "html"
    if "csv" in ct:
        return "csv"
    if "text" in ct:
        return "txt"
    return "bin"


def fetch_preview(session: requests.Session, url: str, headers: Dict[str, str]) -> Dict[str, object]:
    try:
        resp = session.get(url, headers=headers, timeout=TIMEOUT_SECONDS)
        body = resp.content[:MAX_BODY_BYTES]
        ct = resp.headers.get("Content-Type", "")
        out: Dict[str, object] = {
            "ok": bool(resp.ok),
            "status": int(resp.status_code),
            "content_type": ct,
            "body_bytes": int(len(resp.content)),
            "preview_bytes": int(len(body)),
            "body_preview": body,
        }
        if not resp.ok:
            out["error"] = (body.decode("utf-8", errors="replace")[:400] or f"HTTP {resp.status_code}")
        return out
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "content_type": "",
            "body_bytes": 0,
            "preview_bytes": 0,
            "body_preview": b"",
            "error": str(exc),
        }


def save_body(out_base: Path, feed_name: str, data: Dict[str, object]) -> str:
    ct = str(data.get("content_type", ""))
    ext = content_ext(ct)
    file_name = f"{feed_name}.{ext}"
    path = out_base / file_name
    path.write_bytes(data.get("body_preview", b""))
    return str(path.relative_to(ROOT)).replace("\\", "/")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch and save preview snapshots for configured Rail Data feeds.")
    parser.add_argument("--crs", default="KGX", help="CRS code for live board preview (default: KGX)")
    parser.add_argument("--stanox-group", default="", help="stanoxGroup for performance endpoint template")
    parser.add_argument("--current-version", default="", help="currentVersion for reference endpoint template")
    parser.add_argument("--serviceid", default="", help="serviceid for service details template (auto-derives when possible)")
    args = parser.parse_args()

    env = dict(os.environ)
    env.update(load_dotenv(ENV_PATH))
    stanox_group = args.stanox_group.strip() or str(env.get("RAILDATA_STANOX_GROUP_DEFAULT", "")).strip()
    current_version = args.current_version.strip() or str(env.get("RAILDATA_REFERENCE_CURRENT_VERSION_DEFAULT", "")).strip()
    disruptions_crs = str(env.get("RAILDATA_DISRUPTIONS_CRS_DEFAULT", "PAD")).strip().upper()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    run_dir = OUT_DIR / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    headers_base = {
        "Accept": "application/json, application/xml, text/xml, text/plain",
        "User-Agent": "ControlRoomRailPreview/1.0",
    }

    feeds: List[Tuple[str, str, str]] = [
        ("tocs", str(env.get("RAILDATA_TOC_URL", "")).strip(), "RAILDATA_TOC_API_KEY"),
        ("kb_stations", str(env.get("RAILDATA_KB_STATIONS_URL", "")).strip(), "RAILDATA_KB_STATIONS_API_KEY"),
        ("disruptions", str(env.get("RAILDATA_DISRUPTIONS_URL", "")).strip(), "RAILDATA_DISRUPTIONS_API_KEY"),
        ("naptan", str(env.get("RAILDATA_NAPTAN_URL", "")).strip(), "RAILDATA_NAPTAN_API_KEY"),
        ("nptg", str(env.get("RAILDATA_NPTG_URL", "")).strip(), "RAILDATA_NPTG_API_KEY"),
        ("performance_reference", str(env.get("RAILDATA_NWR_PERFORMANCE_REFERENCE_URL", "")).strip(), "RAILDATA_NWR_PERFORMANCE_REFERENCE_API_KEY"),
        ("performance", str(env.get("RAILDATA_NWR_PERFORMANCE_URL", "")).strip(), "RAILDATA_NWR_PERFORMANCE_API_KEY"),
        ("reference_data", str(env.get("RAILDATA_REFERENCE_DATA_URL", "")).strip(), "RAILDATA_REFERENCE_DATA_API_KEY"),
        ("live_board", str(env.get("RAILDATA_LIVE_BOARD_URL", "")).strip(), "RAILDATA_LIVE_BOARD_API_KEY"),
        ("service_details", str(env.get("RAILDATA_SERVICE_DETAILS_URL", "")).strip(), "RAILDATA_SERVICE_DETAILS_API_KEY"),
    ]

    results: List[Dict[str, object]] = []

    service_id = args.serviceid.strip()
    for name, raw_url, feed_key_env in feeds:
        if not raw_url:
            results.append({"feed": name, "ok": False, "skipped": True, "reason": "missing_url"})
            continue

        if name == "disruptions" and "crsCode=" not in raw_url:
            joiner = "&" if "?" in raw_url else "?"
            raw_url = f"{raw_url}{joiner}crsCode={quote_plus(disruptions_crs)}"

        fallback_key = env.get("RAILDATA_API_KEY", "")
        if name == "nptg":
            fallback_key = env.get("RAILDATA_NAPTAN_API_KEY", "") or fallback_key
        api_key = str(env.get(feed_key_env, "") or fallback_key).strip()
        if not api_key:
            results.append({"feed": name, "ok": False, "skipped": True, "reason": f"missing_api_key:{feed_key_env}"})
            continue
        headers = dict(headers_base)
        headers["x-apikey"] = api_key

        rendered, missing = render_template(
            raw_url,
            {
                "crs": args.crs,
                "stanoxGroup": stanox_group,
                "currentVersion": current_version,
                "serviceid": service_id,
            },
        )
        if missing:
            results.append({"feed": name, "ok": False, "skipped": True, "reason": f"missing_template_values:{','.join(missing)}"})
            continue

        data = fetch_preview(session, rendered, headers)
        item: Dict[str, object] = {
            "feed": name,
            "url": rendered,
            "ok": bool(data.get("ok")),
            "status": int(data.get("status", 0)),
            "content_type": str(data.get("content_type", "")),
            "body_bytes": int(data.get("body_bytes", 0)),
            "error": str(data.get("error", "")) if data.get("error") else "",
            "apikey_source": feed_key_env if str(env.get(feed_key_env, "")).strip() else "RAILDATA_API_KEY",
        }
        if data.get("preview_bytes", 0):
            item["preview_file"] = save_body(run_dir, name, data)
        results.append(item)

        if name == "live_board" and data.get("ok"):
            if not service_id:
                try:
                    text = data.get("body_preview", b"").decode("utf-8", errors="replace")
                    parsed = json.loads(text)
                    candidate = ""
                    # Existing schema
                    if isinstance(parsed, dict):
                        candidate = (
                            parsed.get("board", {})
                            .get("services", [{}])[0]
                            .get("serviceID", "")
                        )
                        # RailData live board schema
                        if not candidate:
                            train_services = parsed.get("trainServices", [])
                            if isinstance(train_services, list) and train_services:
                                first = train_services[0] if isinstance(train_services[0], dict) else {}
                                candidate = first.get("serviceID", "") or first.get("serviceId", "")
                    if candidate:
                        service_id = str(candidate).strip()
                except Exception:
                    pass

    # If service details was skipped only because missing serviceid and we derived it from live board, try once.
    if service_id:
        has_service = any(r.get("feed") == "service_details" and not r.get("skipped") for r in results)
        raw_service_url = str(env.get("RAILDATA_SERVICE_DETAILS_URL", "")).strip()
        if raw_service_url and not has_service:
            rendered, missing = render_template(raw_service_url, {"serviceid": service_id})
            if not missing:
                service_key = str(env.get("RAILDATA_SERVICE_DETAILS_API_KEY", "") or env.get("RAILDATA_API_KEY", "")).strip()
                if not service_key:
                    item = {
                        "feed": "service_details",
                        "url": rendered,
                        "ok": False,
                        "status": 0,
                        "content_type": "",
                        "body_bytes": 0,
                        "error": "missing_api_key:RAILDATA_SERVICE_DETAILS_API_KEY",
                        "auto_serviceid_from_live_board": True,
                    }
                    results = [r for r in results if r.get("feed") != "service_details"]
                    results.append(item)
                else:
                    headers = dict(headers_base)
                    headers["x-apikey"] = service_key
                    data = fetch_preview(session, rendered, headers)
                    item = {
                        "feed": "service_details",
                        "url": rendered,
                        "ok": bool(data.get("ok")),
                        "status": int(data.get("status", 0)),
                        "content_type": str(data.get("content_type", "")),
                        "body_bytes": int(data.get("body_bytes", 0)),
                        "error": str(data.get("error", "")) if data.get("error") else "",
                        "auto_serviceid_from_live_board": True,
                        "apikey_source": "RAILDATA_SERVICE_DETAILS_API_KEY" if str(env.get("RAILDATA_SERVICE_DETAILS_API_KEY", "")).strip() else "RAILDATA_API_KEY",
                    }
                    if data.get("preview_bytes", 0):
                        item["preview_file"] = save_body(run_dir, "service_details", data)
                    results = [r for r in results if r.get("feed") != "service_details"]
                    results.append(item)

    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "out_dir": str(run_dir.relative_to(ROOT)).replace("\\", "/"),
        "crs": args.crs,
        "stanox_group": stanox_group,
        "current_version": current_version,
        "disruptions_crs": disruptions_crs,
        "serviceid": service_id,
        "feeds_total": len(results),
        "feeds_ok": sum(1 for r in results if r.get("ok")),
        "feeds_failed_or_skipped": sum(1 for r in results if not r.get("ok")),
        "results": results,
    }

    summary_path = run_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    md_lines = [
        "# Rail Data Preview Report",
        "",
        f"- Generated: `{summary['generated_at_utc']}`",
        f"- Output: `{summary['out_dir']}`",
        f"- OK: `{summary['feeds_ok']}` / `{summary['feeds_total']}`",
        "",
        "| Feed | Status | HTTP | Content-Type | Preview |",
        "|---|---:|---:|---|---|",
    ]
    for r in results:
        status = "OK" if r.get("ok") else f"FAIL ({r.get('reason') or r.get('error') or ''})"
        md_lines.append(
            f"| `{r.get('feed','')}` | {status} | {r.get('status',0)} | `{r.get('content_type','')}` | `{r.get('preview_file','')}` |"
        )
    report_path = run_dir / "report.md"
    report_path.write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    latest_path = OUT_DIR / "latest.json"
    latest_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("Preview complete")
    print(f"Summary: {summary_path}")
    print(f"Report:  {report_path}")
    print(f"OK feeds: {summary['feeds_ok']} / {summary['feeds_total']}")


if __name__ == "__main__":
    main()
