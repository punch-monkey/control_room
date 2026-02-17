import argparse
import base64
import gzip
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional, Dict, Tuple
from urllib.parse import urlsplit, parse_qs, urlencode, quote_plus, quote

ThreadingHTTPServer.allow_reuse_address = True

CH_API_BASE = "https://api.company-information.service.gov.uk"
TFL_API_BASE = "https://api.tfl.gov.uk"
POSTCODES_API_BASE = "https://api.postcodes.io"
OS_PLACES_API_BASE = "https://api.os.uk/search/places/v1"
NRE_LDBWS_URL = "https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb11.asmx"
NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search"
AVIATIONSTACK_BASE = "http://api.aviationstack.com/v1"
UK_RAIL_STATIONS_URL = "https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json"
WEBTRIS_API_BASE = "https://webtris.highwaysengland.co.uk/api"
DVLA_VES_API_BASE = "https://driver-vehicle-licensing.api.gov.uk"
RAILDATA_API_BASE = "https://opendata.nationalrail.co.uk"
FR24_FEED_URL = "https://data-cloud.flightradar24.com/zones/fcgi/feed.js"
FR24_CLICKHANDLER_URL = "https://data-live.flightradar24.com/clickhandler/?flight="
FR24_DEFAULT_BOUNDS = (61.2, 49.7, -11.5, 2.8)
UK_AIRPORT_IATA = {
    "LHR", "LGW", "STN", "LTN", "LCY", "SEN", "MAN", "BHX", "BRS", "LPL", "NCL", "EMA", "NQY", "EXT", "SOU", "BOH", "NWI", "MME", "LBA", "HUY", "CWL",
    "EDI", "GLA", "ABZ", "INV", "PIK", "DND",
    "BFS", "BHD",
    "IOM", "JER", "GCI",
}
UK_AIRSPACE_BOUNDS = {
    "south": 49.3,
    "north": 61.3,
    "west": -9.8,
    "east": 2.8,
}

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HOST = os.environ.get("CR_DEV_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("CR_DEV_PORT", "8000") or 8000)

_station_catalog_cache = {
    "loaded": False,
    "items": [],
}

_raildata_auth_cache = {
    "token": "",
}

RAILDATA_KB_FEEDS = {
    "stations": "/api/staticfeeds/4.0/stations",
    "tocs": "/api/staticfeeds/4.0/tocs",
    "incidents": "/api/staticfeeds/5.0/incidents",
    "service-indicators": "/api/staticfeeds/4.0/serviceIndicators",
    "ticket-restrictions": "/api/staticfeeds/4.0/ticket-restrictions",
    "ticket-types": "/api/staticfeeds/4.0/ticket-types",
    "promotions-public": "/api/staticfeeds/4.0/promotions-publics",
    "routeing": "/api/staticfeeds/2.0/routeing",
}

RAILDATA_ALLOWED_HOSTS = {
    "opendata.nationalrail.co.uk",
    "hsp-prod.rockshore.net",
    "api.nationalrail.co.uk",
    "api1.raildata.org.uk",
    "api.raildata.org.uk",
}

STATIC_ACCELERATED_FILES = {
    "/data/processed/crime_grid.geojson": ("data/processed/crime_grid.geojson", "application/geo+json"),
    "/data/police_force_areas_wgs84.geojson": ("data/police_force_areas_wgs84.geojson", "application/geo+json"),
}

_STATIC_FILE_CACHE: Dict[str, dict] = {}


@dataclass
class DevServerConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    root: Path = PROJECT_ROOT


def parse_server_config(argv: Optional[list] = None) -> DevServerConfig:
    parser = argparse.ArgumentParser(
        description="Control Room development server"
    )
    parser.add_argument("port", nargs="?", type=int, help="Port to bind (default: 8000 or CR_DEV_PORT)")
    parser.add_argument("--port", dest="override_port", type=int, help="Explicit port override")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host/interface to bind (default: %(default)s)")
    parser.add_argument(
        "--root",
        type=Path,
        default=PROJECT_ROOT,
        help="Root directory to serve static assets from",
    )
    args = parser.parse_args(argv)
    host = args.host or DEFAULT_HOST
    positional_port = getattr(args, "port", None)
    port = args.override_port or positional_port or DEFAULT_PORT
    root = args.root.resolve()
    return DevServerConfig(host=host, port=port, root=root)


def b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def load_env_file():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        print(f"Loading environment from: {env_path}")
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ[key.strip()] = value.strip()
                    if key.strip() == "CH_API_KEY":
                        print(f"CH_API_KEY loaded: {value.strip()[:8]}...")
                    if key.strip() == "OS_PLACES_API_KEY":
                        print(f"OS_PLACES_API_KEY loaded: {value.strip()[:8]}...")
                    if key.strip() == "NRE_LDBWS_TOKEN":
                        print(f"NRE_LDBWS_TOKEN loaded: {value.strip()[:8]}...")
                    if key.strip() == "DVLA_API_KEY":
                        print(f"DVLA_API_KEY loaded: {value.strip()[:8]}...")
    else:
        print(f"Warning: No .env file found at {env_path}")
        print("Set CH_API_KEY environment variable or create .env file")


class Handler(SimpleHTTPRequestHandler):
    def _serve_accelerated_static(self, route_path: str) -> bool:
        mapping = STATIC_ACCELERATED_FILES.get(route_path)
        if not mapping:
            return False
        rel_path, mime = mapping
        try:
            fs_path = (PROJECT_ROOT / rel_path).resolve(strict=True)
        except FileNotFoundError:
            return False
        if not str(fs_path).startswith(str(PROJECT_ROOT)):
            return False
        cached = _STATIC_FILE_CACHE.get(route_path)
        mtime = fs_path.stat().st_mtime
        if not cached or cached.get("mtime") != mtime:
            data = fs_path.read_bytes()
            gz = gzip.compress(data)
            cached = {
                "mtime": mtime,
                "raw": data,
                "gzip": gz,
                "type": mime,
            }
            _STATIC_FILE_CACHE[route_path] = cached
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        payload = cached["gzip"] if accepts_gzip else cached["raw"]
        self.send_response(200)
        self.send_header("Content-Type", cached["type"])
        if accepts_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return True

    def _haversine_km(self, lat1, lon1, lat2, lon2):
        import math
        r = 6371.0
        d_lat = math.radians(lat2 - lat1)
        d_lon = math.radians(lon2 - lon1)
        a = (
            math.sin(d_lat / 2) ** 2
            + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
        )
        return 2 * r * math.asin(math.sqrt(a))

    def _load_station_catalog(self):
        if _station_catalog_cache["loaded"]:
            return _station_catalog_cache["items"]
        req = urllib.request.Request(UK_RAIL_STATIONS_URL)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = json.loads(resp.read().decode("utf-8", errors="replace"))
        items = []
        if isinstance(raw, list):
            for r in raw:
                crs = str(r.get("crsCode") or "").strip().upper()
                name = str(r.get("stationName") or "").strip()
                if len(crs) == 3 and name:
                    items.append(
                        {
                            "crs": crs,
                            "name": name,
                            "country": str(r.get("constituentCountry") or "").strip().lower(),
                            "lat": r.get("lat"),
                            "lon": r.get("long"),
                        }
                    )
        _station_catalog_cache["loaded"] = True
        _station_catalog_cache["items"] = items
        return items

    def _send_json_error(self, status: int, payload: bytes):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _proxy_get(self, upstream_url: str, headers: Optional[Dict[str, str]] = None):
        req = urllib.request.Request(upstream_url)
        req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
        if headers:
            for key, value in headers.items():
                req.add_header(key, value)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return True
        except urllib.error.HTTPError as e:
            body = e.read() if hasattr(e, "read") else b"{}"
            self._send_json_error(e.code, body)
            return True
        except Exception as e:
            payload = ("{\"error\":\"Upstream failed\",\"detail\":\"%s\"}" % str(e)).encode("utf-8")
            self._send_json_error(502, payload)
            return True

    def _send_json(self, payload, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_response(self, resp) -> Optional[dict]:
        try:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _is_allowed_raildata_url(self, url: str) -> bool:
        try:
            parsed = urlsplit(str(url or "").strip())
            if parsed.scheme not in {"http", "https"}:
                return False
            host = (parsed.hostname or "").lower()
            return host in RAILDATA_ALLOWED_HOSTS
        except Exception:
            return False

    def _render_url_template(self, url_template: str, values: Dict[str, str]):
        url = str(url_template or "")
        needed = [part[1] for part in re.findall(r"(\{([A-Za-z0-9_]+)\})", url)]
        missing = []
        for key in needed:
            value = str(values.get(key, "")).strip()
            if not value:
                missing.append(key)
                continue
            url = url.replace(f"{{{key}}}", quote_plus(value))
        return url, missing

    def _proxy_raildata_url(self, upstream_url: str, auth_mode: str = "token", apikey_env: str = "RAILDATA_API_KEY"):
        if not self._is_allowed_raildata_url(upstream_url):
            self._send_json(
                {
                    "error": "Blocked RailData URL host",
                    "url": upstream_url,
                    "allowed_hosts": sorted(RAILDATA_ALLOWED_HOSTS),
                },
                status=400,
            )
            return True

        req = urllib.request.Request(upstream_url)
        req.add_header("Accept", "application/json, application/xml, text/xml, text/plain, application/octet-stream")
        req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")

        if auth_mode == "token":
            token, err = self._get_raildata_auth_token()
            if err:
                self._send_json(err, status=500)
                return True
            req.add_header("X-Auth-Token", token or "")
        elif auth_mode == "apikey":
            api_key = os.environ.get(apikey_env, "").strip()
            if not api_key:
                self._send_json({"error": f"{apikey_env} env var not set"}, status=500)
                return True
            req.add_header("x-apikey", api_key)
        elif auth_mode == "basic":
            username = os.environ.get("RAILDATA_USERNAME", "").strip()
            password = os.environ.get("RAILDATA_PASSWORD", "").strip()
            if not username or not password:
                self._send_json({"error": "RAILDATA_USERNAME and RAILDATA_PASSWORD required for basic auth endpoint"}, status=500)
                return True
            req.add_header("Authorization", f"Basic {b64(f'{username}:{password}')}")

        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return True
        except urllib.error.HTTPError as e:
            body = e.read() if hasattr(e, "read") else b"{}"
            if e.code == 401 and auth_mode == "token" and not os.environ.get("RAILDATA_AUTH_TOKEN", "").strip():
                _raildata_auth_cache["token"] = ""
            self._send_json_error(e.code, body)
            return True
        except Exception as e:
            self._send_json({"error": "RailData upstream failed", "detail": str(e)}, status=502)
            return True

    def _get_raildata_auth_token(self) -> Tuple[Optional[str], Optional[dict]]:
        direct = os.environ.get("RAILDATA_AUTH_TOKEN", "").strip()
        if direct:
            return direct, None

        cached = _raildata_auth_cache.get("token", "").strip()
        if cached:
            return cached, None

        username = os.environ.get("RAILDATA_USERNAME", "").strip()
        password = os.environ.get("RAILDATA_PASSWORD", "").strip()
        if not username or not password:
            return None, {"error": "RAILDATA credentials not set (use RAILDATA_AUTH_TOKEN or RAILDATA_USERNAME/RAILDATA_PASSWORD)"}

        attempts = [
            ("/api/v1/token", {"username": username, "password": password}),
            ("/api/v1/authenticate", {"username": username, "password": password}),
            ("/api/v1/token", {"email": username, "password": password}),
            ("/api/v1/authenticate", {"email": username, "password": password}),
        ]
        for path, payload in attempts:
            try:
                req = urllib.request.Request(f"{RAILDATA_API_BASE}{path}", data=json.dumps(payload).encode("utf-8"), method="POST")
                req.add_header("Accept", "application/json")
                req.add_header("Content-Type", "application/json")
                req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = self._read_json_response(resp) or {}
                    token = str(
                        data.get("token")
                        or data.get("authToken")
                        or data.get("authenticationToken")
                        or data.get("accessToken")
                        or ""
                    ).strip()
                    if token:
                        _raildata_auth_cache["token"] = token
                        return token, None
            except urllib.error.HTTPError:
                continue
            except Exception:
                continue
        return None, {"error": "Unable to authenticate with Rail Data API"}

    def _xml_local_name(self, tag: str) -> str:
        return tag.split("}", 1)[1] if "}" in tag else tag

    def _find_first_text(self, root, name: str, default: str = "") -> str:
        for el in root.iter():
            if self._xml_local_name(el.tag) == name:
                return (el.text or "").strip()
        return default

    def _children_by_local_name(self, root, name: str):
        out = []
        for el in root.iter():
            if self._xml_local_name(el.tag) == name:
                out.append(el)
        return out

    def _parse_service(self, service_el):
        def gt(n, d=""):
            for ch in service_el.iter():
                if self._xml_local_name(ch.tag) == n:
                    return (ch.text or "").strip() or d
            return d

        origins = []
        destinations = []
        for origin in self._children_by_local_name(service_el, "origin"):
            names = [self._find_first_text(loc, "locationName", "") for loc in self._children_by_local_name(origin, "location")]
            names = [n for n in names if n]
            if names:
                origins.extend(names)
        for dest in self._children_by_local_name(service_el, "destination"):
            names = [self._find_first_text(loc, "locationName", "") for loc in self._children_by_local_name(dest, "location")]
            names = [n for n in names if n]
            if names:
                destinations.extend(names)

        return {
            "serviceID": gt("serviceID"),
            "std": gt("std"),
            "etd": gt("etd"),
            "sta": gt("sta"),
            "eta": gt("eta"),
            "platform": gt("platform"),
            "operator": gt("operator"),
            "operatorCode": gt("operatorCode"),
            "length": gt("length"),
            "origin": origins,
            "destination": destinations,
        }

    def _normalize_raildata_board(self, raw: dict, board_type: str, crs_fallback: str = "") -> dict:
        if not isinstance(raw, dict):
            return {"generatedAt": "", "locationName": "", "crs": crs_fallback, "nrccMessages": [], "services": []}

        def nrcc_text(msg):
            if msg is None:
                return ""
            if isinstance(msg, str):
                return msg.strip()
            if isinstance(msg, dict):
                direct = str(msg.get("message") or msg.get("value") or msg.get("text") or msg.get("reason") or msg.get("content") or "").strip()
                if direct:
                    return direct
                for v in msg.values():
                    if isinstance(v, str) and v.strip():
                        return v.strip()
            return ""

        services = []
        for svc in (raw.get("trainServices") or []):
            if not isinstance(svc, dict):
                continue
            origin = [str(x.get("locationName", "")).strip() for x in (svc.get("origin") or []) if isinstance(x, dict) and str(x.get("locationName", "")).strip()]
            destination = [str(x.get("locationName", "")).strip() for x in (svc.get("destination") or []) if isinstance(x, dict) and str(x.get("locationName", "")).strip()]
            services.append(
                {
                    "serviceID": str(svc.get("serviceID") or svc.get("serviceId") or "").strip(),
                    "std": str(svc.get("std") or "").strip(),
                    "etd": str(svc.get("etd") or "").strip(),
                    "sta": str(svc.get("sta") or "").strip(),
                    "eta": str(svc.get("eta") or "").strip(),
                    "platform": str(svc.get("platform") or "").strip(),
                    "operator": str(svc.get("operator") or "").strip(),
                    "operatorCode": str(svc.get("operatorCode") or "").strip(),
                    "length": str(svc.get("length") or "").strip(),
                    "origin": origin,
                    "destination": destination,
                }
            )
        return {
            "generatedAt": str(raw.get("generatedAt") or ""),
            "locationName": str(raw.get("locationName") or ""),
            "crs": str(raw.get("crs") or crs_fallback or ""),
            "nrccMessages": [nrcc_text(m) for m in (raw.get("nrccMessages") or []) if nrcc_text(m)],
            "services": services,
        }

    def _fetch_raildata_board_fallback(self, crs: str, board_type: str):
        if board_type == "departures":
            tpl = os.environ.get("RAILDATA_LIVE_DEPARTURE_URL", "").strip()
            key_env = "RAILDATA_LIVE_DEPARTURE_API_KEY"
        else:
            tpl = os.environ.get("RAILDATA_LIVE_BOARD_URL", "").strip()
            key_env = "RAILDATA_LIVE_BOARD_API_KEY"
        if not tpl:
            return None, {"error": f"{'RAILDATA_LIVE_DEPARTURE_URL' if board_type == 'departures' else 'RAILDATA_LIVE_BOARD_URL'} env var not set"}
        rendered, missing = self._render_url_template(tpl, {"crs": crs})
        if missing:
            return None, {"error": "Missing template values", "missing": missing}
        api_key = os.environ.get(key_env, "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()
        if not api_key:
            return None, {"error": f"{key_env} env var not set"}
        try:
            req = urllib.request.Request(rendered)
            req.add_header("Accept", "application/json")
            req.add_header("x-apikey", api_key)
            req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(text)
                return self._normalize_raildata_board(parsed, board_type, crs), None
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                body = str(e)
            return None, {"error": f"RailData board HTTP {e.code}", "detail": body}
        except Exception as e:
            return None, {"error": "RailData board request failed", "detail": str(e)}

    def _fetch_raildata_service_details_fallback(self, service_id: str):
        tpl = os.environ.get("RAILDATA_SERVICE_DETAILS_URL", "").strip()
        if not tpl:
            return None, {"error": "RAILDATA_SERVICE_DETAILS_URL env var not set"}
        rendered, missing = self._render_url_template(tpl, {"serviceid": service_id})
        if missing:
            return None, {"error": "Missing template values", "missing": missing}
        api_key = os.environ.get("RAILDATA_SERVICE_DETAILS_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()
        if not api_key:
            return None, {"error": "RAILDATA_SERVICE_DETAILS_API_KEY env var not set"}
        try:
            req = urllib.request.Request(rendered)
            req.add_header("Accept", "application/json")
            req.add_header("x-apikey", api_key)
            req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(text)
                def stop_obj(x):
                    if not isinstance(x, dict):
                        return None
                    crs = str(x.get("crs") or x.get("CRS") or "").strip().upper()
                    name = str(x.get("locationName") or x.get("stationName") or x.get("name") or "").strip()
                    if not crs and not name:
                        return None
                    return {"crs": crs, "name": name}

                def collect(raw, out, seen):
                    if raw is None:
                        return
                    if isinstance(raw, list):
                        for item in raw:
                            collect(item, out, seen)
                        return
                    if not isinstance(raw, dict):
                        return
                    st = stop_obj(raw)
                    if st:
                        key = st["crs"] or st["name"].lower()
                        if key and key not in seen:
                            seen.add(key)
                            out.append(st)
                    for key in ("callingPoint", "callingPoints", "previousCallingPoints", "subsequentCallingPoints"):
                        if key in raw:
                            collect(raw.get(key), out, seen)

                points = []
                seen_points = set()
                collect(parsed.get("previousCallingPoints"), points, seen_points)
                collect({"crs": parsed.get("crs"), "locationName": parsed.get("locationName")}, points, seen_points)
                collect(parsed.get("subsequentCallingPoints"), points, seen_points)
                if not points:
                    collect(parsed.get("origin"), points, seen_points)
                    collect(parsed.get("destination"), points, seen_points)

                service = {
                    "serviceID": str(parsed.get("serviceID") or parsed.get("serviceId") or service_id),
                    "operator": str(parsed.get("operator") or ""),
                    "std": str(parsed.get("std") or ""),
                    "etd": str(parsed.get("etd") or ""),
                    "sta": str(parsed.get("sta") or ""),
                    "eta": str(parsed.get("eta") or ""),
                    "platform": str(parsed.get("platform") or ""),
                    "delayReason": str(parsed.get("delayReason") or ""),
                    "cancelReason": str(parsed.get("cancelReason") or ""),
                    "locationName": str(parsed.get("locationName") or ""),
                    "crs": str(parsed.get("crs") or "").upper(),
                    "callingPoints": points,
                }
                return service, None
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                body = str(e)
            return None, {"error": f"RailData service HTTP {e.code}", "detail": body}
        except Exception as e:
            return None, {"error": "RailData service request failed", "detail": str(e)}

    def _build_ldbws_envelope(self, token: str, method: str, body_xml: str) -> bytes:
        envelope = f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ldb="http://thalesgroup.com/RTTI/2017-10-01/ldb/">
  <soap:Header>
    <AccessToken xmlns="http://thalesgroup.com/RTTI/2013-11-28/Token/types">
      <TokenValue>{token}</TokenValue>
    </AccessToken>
  </soap:Header>
  <soap:Body>
    <ldb:{method}Request>
      {body_xml}
    </ldb:{method}Request>
  </soap:Body>
</soap:Envelope>
"""
        return envelope.encode("utf-8")

    def _http_get_json_gzip(self, url: str, timeout_s: int = 15):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Encoding": "gzip",
                    "Referer": "https://www.flightradar24.com/",
                    "Origin": "https://www.flightradar24.com",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read()
                enc = (resp.headers.get("Content-Encoding") or "").strip().lower()
                if enc == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:
            return None

    def _fr24_fetch_feed(self, bounds):
        try:
            n, s, w, e = bounds
        except Exception:
            n, s, w, e = FR24_DEFAULT_BOUNDS
        params = {
            "faa": "1",
            "satellite": "1",
            "mlat": "1",
            "flarm": "1",
            "adsb": "1",
            "gnd": "1",
            "air": "1",
            "vehicles": "0",
            "estimated": "1",
            "maxage": "14400",
            "gliders": "0",
            "stats": "1",
            "limit": "1500",
            "bounds": f"{n},{s},{w},{e}",
        }
        url = FR24_FEED_URL + "?" + urlencode(params)
        return self._http_get_json_gzip(url, timeout_s=15)

    def _fr24_extract_flights(self, payload):
        flights = []
        if not isinstance(payload, dict):
            return flights
        for fid, info in payload.items():
            fid_s = str(fid or "")
            if not fid_s or not fid_s[0].isdigit():
                continue
            if not isinstance(info, list) or len(info) < 17:
                continue

            def at(i):
                try:
                    return info[i]
                except Exception:
                    return None

            lat = at(1)
            lon = at(2)
            if lat is None or lon is None:
                continue
            flights.append(
                {
                    "id": fid_s,
                    "icao24": at(0),
                    "lat": lat,
                    "lon": lon,
                    "heading": at(3),
                    "altitude": at(4),
                    "speed": at(5),
                    "squawk": at(6),
                    "aircraft": at(8),
                    "registration": at(9),
                    "time": at(10),
                    "origin": at(11),
                    "destination": at(12),
                    "number": at(13),
                    "onGround": at(14),
                    "verticalSpeed": at(15),
                    "callsign": at(16),
                    "airlineIcao": at(18),
                }
            )
        return flights

    def _fr24_fetch_details(self, flight_id: str):
        fid = str(flight_id or "").strip()
        if not fid:
            return None
        url = FR24_CLICKHANDLER_URL + quote(fid, safe="")
        data = self._http_get_json_gzip(url, timeout_s=15)
        return data if isinstance(data, dict) else None

    def _call_ldbws(self, method: str, body_xml: str):
        token = os.environ.get("NRE_LDBWS_TOKEN", "").strip()
        if not token:
            return None, {"error": "NRE_LDBWS_TOKEN env var not set"}

        endpoint = os.environ.get("NRE_LDBWS_URL", NRE_LDBWS_URL).strip() or NRE_LDBWS_URL
        payload = self._build_ldbws_envelope(token, method, body_xml)
        req = urllib.request.Request(endpoint, data=payload, method="POST")
        req.add_header("Content-Type", "text/xml; charset=utf-8")
        req.add_header("Accept", "text/xml")
        req.add_header("SOAPAction", f"http://thalesgroup.com/RTTI/2017-10-01/ldb/{method}")
        req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                xml_body = resp.read()
                root = ET.fromstring(xml_body)
                for el in root.iter():
                    if self._xml_local_name(el.tag) == "Fault":
                        fault_string = self._find_first_text(el, "faultstring", "SOAP Fault")
                        return None, {"error": "LDBWS SOAP fault", "detail": fault_string}
                return root, None
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                detail = str(e)
            return None, {"error": f"HTTP {e.code}", "detail": detail}
        except Exception as e:
            return None, {"error": "LDBWS request failed", "detail": str(e)}

    def _parse_station_board(self, root):
        board = None
        for el in root.iter():
            if self._xml_local_name(el.tag) in ("GetStationBoardResult", "StationBoardResult"):
                board = el
                break
        if board is None:
            return {
                "generatedAt": "",
                "locationName": "",
                "crs": "",
                "nrccMessages": [],
                "services": [],
            }

        out = {
            "generatedAt": self._find_first_text(board, "generatedAt", ""),
            "locationName": self._find_first_text(board, "locationName", ""),
            "crs": self._find_first_text(board, "crs", ""),
            "nrccMessages": [],
            "services": [],
        }
        for msg_el in self._children_by_local_name(board, "nrccMessage"):
            txt = (msg_el.text or "").strip()
            if txt:
                out["nrccMessages"].append(txt)

        service_list = []
        for list_name in ("trainServices", "busServices", "ferryServices"):
            for svc_list in self._children_by_local_name(board, list_name):
                for svc in svc_list:
                    if self._xml_local_name(svc.tag) == "service":
                        service_list.append(self._parse_service(svc))
        out["services"] = service_list
        return out

    def _parse_service_details(self, root):
        details = None
        for el in root.iter():
            if self._xml_local_name(el.tag) in ("GetServiceDetailsResult", "ServiceDetailsResult"):
                details = el
                break
        if details is None:
            return {}
        return {
            "generatedAt": self._find_first_text(details, "generatedAt", ""),
            "serviceType": self._find_first_text(details, "serviceType", ""),
            "locationName": self._find_first_text(details, "locationName", ""),
            "crs": self._find_first_text(details, "crs", ""),
            "operator": self._find_first_text(details, "operator", ""),
            "operatorCode": self._find_first_text(details, "operatorCode", ""),
            "rsid": self._find_first_text(details, "rsid", ""),
            "std": self._find_first_text(details, "std", ""),
            "etd": self._find_first_text(details, "etd", ""),
            "sta": self._find_first_text(details, "sta", ""),
            "eta": self._find_first_text(details, "eta", ""),
            "platform": self._find_first_text(details, "platform", ""),
            "isCancelled": self._find_first_text(details, "isCancelled", ""),
            "cancelReason": self._find_first_text(details, "cancelReason", ""),
            "delayReason": self._find_first_text(details, "delayReason", ""),
        }

    def do_GET(self):
        clean_path = self.path.split("?", 1)[0]
        if clean_path in STATIC_ACCELERATED_FILES and self._serve_accelerated_static(clean_path):
            return

        if self.path.startswith("/__control_room_health"):
            self._send_json(
                {
                    "ok": True,
                    "service": "control-room-dev-server",
                    "ts": int(time.time()),
                }
            )
            return

        if self.path.startswith("/ch/"):
            api_key = os.environ.get("CH_API_KEY", "").strip()
            if not api_key:
                self._send_json_error(500, b'{"error":"CH_API_KEY env var not set"}')
                return

            upstream_url = CH_API_BASE + self.path.replace("/ch", "", 1)
            self._proxy_get(
                upstream_url,
                headers={
                    "Authorization": "Basic " + b64(f"{api_key}:"),
                    "Accept": "application/json",
                },
            )
            return

        if self.path.startswith("/tfl/"):
            upstream_url = TFL_API_BASE + self.path.replace("/tfl", "", 1)
            self._proxy_get(upstream_url, headers={"Accept": "application/json"})
            return

        if self.path.startswith("/postcodes/"):
            upstream_url = POSTCODES_API_BASE + self.path.replace("/postcodes", "", 1)
            self._proxy_get(upstream_url, headers={"Accept": "application/json"})
            return

        if self.path.startswith("/webtris/"):
            upstream_url = WEBTRIS_API_BASE + "/" + self.path.replace("/webtris/", "", 1)
            self._proxy_get(upstream_url, headers={"Accept": "application/json"})
            return

        if self.path.startswith("/dvla/health"):
            key = os.environ.get("DVLA_API_KEY", "").strip()
            self._send_json({"ok": True, "configured": bool(key), "endpoint": f"{DVLA_VES_API_BASE}/vehicle-enquiry/v1/vehicles"})
            return

        if self.path.startswith("/osplaces/postcode"):
            os_key = os.environ.get("OS_PLACES_API_KEY", "").strip()
            if not os_key:
                self._send_json_error(500, b'{"error":"OS_PLACES_API_KEY env var not set"}')
                return

            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            postcode = (params.get("postcode") or [""])[0].strip()
            if not postcode:
                self._send_json_error(400, b'{"error":"postcode query parameter required"}')
                return

            query = urlencode(
                {
                    "postcode": postcode,
                    "key": os_key,
                    "maxresults": "1",
                    "output_srs": "EPSG:4326",
                }
            )
            upstream_url = f"{OS_PLACES_API_BASE}/postcode?{query}"
            self._proxy_get(upstream_url, headers={"Accept": "application/json"})
            return

        if self.path.startswith("/nre/health"):
            token = os.environ.get("NRE_LDBWS_TOKEN", "").strip()
            live_dep_url = os.environ.get("RAILDATA_LIVE_DEPARTURE_URL", "").strip()
            live_dep_key = os.environ.get("RAILDATA_LIVE_DEPARTURE_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()
            live_board_url = os.environ.get("RAILDATA_LIVE_BOARD_URL", "").strip()
            live_board_key = os.environ.get("RAILDATA_LIVE_BOARD_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()

            raildata_departures_ready = bool(live_dep_url and live_dep_key)
            raildata_arrivals_ready = bool(live_board_url and live_board_key)
            configured = bool(token or raildata_departures_ready or raildata_arrivals_ready)

            provider = "darwin" if token else ("raildata" if (raildata_departures_ready or raildata_arrivals_ready) else "none")
            self._send_json(
                {
                    "ok": True,
                    "configured": configured,
                    "provider": provider,
                    "endpoint": os.environ.get("NRE_LDBWS_URL", NRE_LDBWS_URL),
                    "fallback": {
                        "raildata_departures_ready": raildata_departures_ready,
                        "raildata_arrivals_ready": raildata_arrivals_ready,
                    },
                }
            )
            return

        if self.path.startswith("/raildata/health"):
            has_direct_token = bool(os.environ.get("RAILDATA_AUTH_TOKEN", "").strip())
            has_credentials = bool(os.environ.get("RAILDATA_USERNAME", "").strip() and os.environ.get("RAILDATA_PASSWORD", "").strip())
            self._send_json(
                {
                    "ok": True,
                    "configured": bool(has_direct_token or has_credentials),
                    "auth_mode": "token" if has_direct_token else ("username_password" if has_credentials else ("apikey" if os.environ.get("RAILDATA_API_KEY", "").strip() else "none")),
                    "kb_feeds": sorted(RAILDATA_KB_FEEDS.keys()),
                    "helpers": [
                        "/raildata/feeds",
                        "/raildata/feeds/available",
                        "/raildata/disruptions",
                        "/raildata/performance",
                        "/raildata/performance/reference",
                        "/raildata/reference",
                        "/raildata/naptan",
                        "/raildata/nptg",
                        "/raildata/proxy?url=<full-feed-url>",
                    ],
                    "endpoint": RAILDATA_API_BASE,
                }
            )
            return

        if self.path.startswith("/raildata/feeds/available"):
            return self._proxy_raildata_url(f"{RAILDATA_API_BASE}/api/feeds/available", auth_mode="token")

        if self.path.startswith("/raildata/feeds"):
            return self._proxy_raildata_url(f"{RAILDATA_API_BASE}/api/feeds", auth_mode="token")

        if self.path.startswith("/raildata/user"):
            return self._proxy_raildata_url(f"{RAILDATA_API_BASE}/api/user", auth_mode="token")

        if self.path.startswith("/raildata/kb/"):
            parsed = urlsplit(self.path)
            feed = parsed.path.replace("/raildata/kb/", "", 1).strip().lower()
            env_url_map = {
                "tocs": os.environ.get("RAILDATA_TOC_URL", "").strip(),
                "stations": os.environ.get("RAILDATA_KB_STATIONS_URL", "").strip(),
            }
            env_key_map = {
                "tocs": "RAILDATA_TOC_API_KEY",
                "stations": "RAILDATA_KB_STATIONS_API_KEY",
            }
            explicit_url = env_url_map.get(feed, "")
            query = f"?{parsed.query}" if parsed.query else ""
            if explicit_url:
                return self._proxy_raildata_url(f"{explicit_url}{query}", auth_mode="apikey", apikey_env=env_key_map.get(feed, "RAILDATA_API_KEY"))

            upstream_path = RAILDATA_KB_FEEDS.get(feed)
            if not upstream_path:
                self._send_json(
                    {
                        "error": "Unknown KB feed",
                        "feed": feed,
                        "supported_feeds": sorted(RAILDATA_KB_FEEDS.keys()),
                    },
                    status=400,
                )
                return
            upstream_url = f"{RAILDATA_API_BASE}{upstream_path}{query}"
            mode = "apikey" if (os.environ.get("RAILDATA_TOC_API_KEY", "").strip() or os.environ.get("RAILDATA_KB_STATIONS_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(upstream_url, auth_mode=mode)

        if self.path.startswith("/raildata/disruptions"):
            configured = os.environ.get("RAILDATA_DISRUPTIONS_URL", "").strip()
            upstream_url = configured or f"{RAILDATA_API_BASE}{RAILDATA_KB_FEEDS['incidents']}"
            mode = "apikey" if (os.environ.get("RAILDATA_DISRUPTIONS_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(upstream_url, auth_mode=mode, apikey_env="RAILDATA_DISRUPTIONS_API_KEY")

        if self.path.startswith("/raildata/performance/reference"):
            configured = os.environ.get("RAILDATA_NWR_PERFORMANCE_REFERENCE_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_NWR_PERFORMANCE_REFERENCE_URL not set",
                        "hint": "Paste the exact subscribed endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            mode = "apikey" if (os.environ.get("RAILDATA_NWR_PERFORMANCE_REFERENCE_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(configured, auth_mode=mode, apikey_env="RAILDATA_NWR_PERFORMANCE_REFERENCE_API_KEY")

        if self.path.startswith("/raildata/performance"):
            configured = os.environ.get("RAILDATA_NWR_PERFORMANCE_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_NWR_PERFORMANCE_URL not set",
                        "hint": "Paste the exact subscribed endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            rendered, missing = self._render_url_template(
                configured,
                {"stanoxGroup": (params.get("stanoxGroup") or [""])[0]},
            )
            if missing:
                self._send_json({"error": "Missing required query parameter(s)", "missing": missing}, status=400)
                return
            mode = "apikey" if (os.environ.get("RAILDATA_NWR_PERFORMANCE_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(rendered, auth_mode=mode, apikey_env="RAILDATA_NWR_PERFORMANCE_API_KEY")

        if self.path.startswith("/raildata/reference"):
            configured = os.environ.get("RAILDATA_REFERENCE_DATA_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_REFERENCE_DATA_URL not set",
                        "hint": "Paste the exact subscribed endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            rendered, missing = self._render_url_template(
                configured,
                {"currentVersion": (params.get("currentVersion") or [""])[0]},
            )
            if missing:
                self._send_json({"error": "Missing required query parameter(s)", "missing": missing}, status=400)
                return
            mode = "apikey" if (os.environ.get("RAILDATA_REFERENCE_DATA_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(rendered, auth_mode=mode, apikey_env="RAILDATA_REFERENCE_DATA_API_KEY")

        if self.path.startswith("/raildata/naptan"):
            configured = os.environ.get("RAILDATA_NAPTAN_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_NAPTAN_URL not set",
                        "hint": "Paste NaPTAN endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            mode = "apikey" if (os.environ.get("RAILDATA_NAPTAN_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(configured, auth_mode=mode, apikey_env="RAILDATA_NAPTAN_API_KEY")

        if self.path.startswith("/raildata/nptg"):
            configured = os.environ.get("RAILDATA_NPTG_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_NPTG_URL not set",
                        "hint": "Paste NPTG endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            mode = "apikey" if (os.environ.get("RAILDATA_NPTG_API_KEY", "").strip() or os.environ.get("RAILDATA_NAPTAN_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            apikey_env = "RAILDATA_NPTG_API_KEY"
            if not os.environ.get(apikey_env, "").strip() and os.environ.get("RAILDATA_NAPTAN_API_KEY", "").strip():
                apikey_env = "RAILDATA_NAPTAN_API_KEY"
            return self._proxy_raildata_url(configured, auth_mode=mode, apikey_env=apikey_env)

        if self.path.startswith("/raildata/service-details"):
            configured = os.environ.get("RAILDATA_SERVICE_DETAILS_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_SERVICE_DETAILS_URL not set",
                        "hint": "Paste Service Details endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            rendered, missing = self._render_url_template(
                configured,
                {"serviceid": (params.get("serviceid") or [""])[0]},
            )
            if missing:
                self._send_json({"error": "Missing required query parameter(s)", "missing": missing}, status=400)
                return
            mode = "apikey" if (os.environ.get("RAILDATA_SERVICE_DETAILS_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(rendered, auth_mode=mode, apikey_env="RAILDATA_SERVICE_DETAILS_API_KEY")

        if self.path.startswith("/raildata/live-board"):
            configured = os.environ.get("RAILDATA_LIVE_BOARD_URL", "").strip()
            if not configured:
                self._send_json(
                    {
                        "error": "RAILDATA_LIVE_BOARD_URL not set",
                        "hint": "Paste Live Arrival and Departure Boards endpoint URL from Rail Data My Feeds.",
                    },
                    status=400,
                )
                return
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            rendered, missing = self._render_url_template(
                configured,
                {"crs": (params.get("crs") or [""])[0]},
            )
            if missing:
                self._send_json({"error": "Missing required query parameter(s)", "missing": missing}, status=400)
                return
            mode = "apikey" if (os.environ.get("RAILDATA_LIVE_BOARD_API_KEY", "").strip() or os.environ.get("RAILDATA_API_KEY", "").strip()) else "token"
            return self._proxy_raildata_url(rendered, auth_mode=mode, apikey_env="RAILDATA_LIVE_BOARD_API_KEY")

        if self.path.startswith("/raildata/proxy"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            url = ((params.get("url") or [""])[0]).strip()
            auth_mode = ((params.get("auth") or ["token"])[0]).strip().lower()
            if not url:
                self._send_json({"error": "url query parameter required"}, status=400)
                return
            if auth_mode not in {"token", "basic", "apikey", "none"}:
                self._send_json({"error": "auth must be token|basic|apikey|none"}, status=400)
                return
            return self._proxy_raildata_url(url, auth_mode=auth_mode if auth_mode != "none" else "")

        if self.path.startswith("/nre/departures") or self.path.startswith("/nre/arrivals"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            crs = ((params.get("crs") or [""])[0]).strip().upper()
            rows = ((params.get("rows") or ["10"])[0]).strip()
            if not crs or len(crs) != 3:
                self._send_json({"error": "crs query parameter required (3-letter station code)"}, status=400)
                return
            method = "GetDepartureBoard" if self.path.startswith("/nre/departures") else "GetArrivalBoard"
            body = f"<ldb:numRows>{rows or '10'}</ldb:numRows><ldb:crs>{crs}</ldb:crs>"
            root, err = self._call_ldbws(method, body)
            if err:
                board_type = "departures" if method == "GetDepartureBoard" else "arrivals"
                fallback_board, fb_err = self._fetch_raildata_board_fallback(crs, board_type)
                if fallback_board:
                    self._send_json({"ok": True, "type": board_type, "provider": "raildata", "board": fallback_board})
                    return
                self._send_json({"error": err.get("error", "NRE failed"), "detail": err.get("detail", ""), "fallback": fb_err or {}}, status=502)
                return
            board = self._parse_station_board(root)
            self._send_json({"ok": True, "type": "departures" if method == "GetDepartureBoard" else "arrivals", "board": board})
            return

        if self.path.startswith("/nre/stations"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            q = ((params.get("q") or [""])[0]).strip().lower()
            crs = ((params.get("crs") or [""])[0]).strip().upper()
            limit_s = ((params.get("limit") or ["20"])[0]).strip()
            try:
                limit = max(1, min(5000, int(limit_s)))
            except Exception:
                limit = 20
            try:
                items = self._load_station_catalog()
            except Exception as e:
                self._send_json({"ok": False, "error": "station catalog unavailable", "detail": str(e), "stations": []}, status=502)
                return

            if crs and len(crs) == 3:
                base = None
                for st in items:
                    if st["crs"] == crs:
                        base = st
                        break
                if not base:
                    self._send_json({"ok": True, "base": None, "stations": []})
                    return
                try:
                    lat1 = float(base.get("lat"))
                    lon1 = float(base.get("lon"))
                except Exception:
                    self._send_json({"ok": True, "base": base, "stations": []})
                    return
                nearby = []
                for st in items:
                    if st["crs"] == crs:
                        continue
                    try:
                        lat2 = float(st.get("lat"))
                        lon2 = float(st.get("lon"))
                    except Exception:
                        continue
                    d = self._haversine_km(lat1, lon1, lat2, lon2)
                    if d <= 45:
                        nearby.append((d, st))
                nearby.sort(key=lambda x: x[0])
                out = []
                for d, st in nearby[:limit]:
                    cp = dict(st)
                    cp["distanceKm"] = round(d, 2)
                    out.append(cp)
                self._send_json({"ok": True, "base": base, "stations": out})
                return

            if not q:
                top = items[:limit]
                self._send_json({"ok": True, "stations": top})
                return

            q_upper = q.upper()
            scored = []
            for st in items:
                name_l = st["name"].lower()
                crs = st["crs"]
                score = 0
                if crs == q_upper:
                    score += 200
                elif crs.startswith(q_upper):
                    score += 120
                if name_l.startswith(q):
                    score += 80
                if q in name_l:
                    score += 40
                if score > 0:
                    scored.append((score, st))

            scored.sort(key=lambda pair: (-pair[0], pair[1]["name"]))
            out = [s for _, s in scored[:limit]]
            self._send_json({"ok": True, "stations": out})
            return

        if self.path.startswith("/nre/service"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            service_id = ((params.get("service_id") or [""])[0]).strip()
            if not service_id:
                self._send_json({"error": "service_id query parameter required"}, status=400)
                return
            body = f"<ldb:serviceID>{service_id}</ldb:serviceID>"
            root, err = self._call_ldbws("GetServiceDetails", body)
            if err:
                fallback_service, fb_err = self._fetch_raildata_service_details_fallback(service_id)
                if fallback_service:
                    self._send_json({"ok": True, "provider": "raildata", "service": fallback_service})
                    return
                self._send_json({"error": err.get("error", "NRE failed"), "detail": err.get("detail", ""), "fallback": fb_err or {}}, status=502)
                return
            self._send_json({"ok": True, "service": self._parse_service_details(root)})
            return

        if self.path.startswith("/geo/search"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            q = ((params.get("q") or [""])[0]).strip()
            limit = ((params.get("limit") or ["1"])[0]).strip()
            if not q:
                self._send_json({"error": "q query parameter required"}, status=400)
                return
            upstream = f"{NOMINATIM_BASE}?q={quote_plus(q)}&format=jsonv2&limit={quote_plus(limit)}"
            self._proxy_get(
                upstream,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "ControlRoom/1.0 (+https://localhost)",
                },
            )
            return

        if self.path.startswith("/api/flightradar/flights"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")

            uk_only_raw = ((params.get("ukOnly") or ["0"])[0]).strip().lower()
            uk_only = uk_only_raw in {"1", "true", "yes", "on"}

            def as_float(value, fallback):
                try:
                    return float(str(value).strip())
                except Exception:
                    return fallback

            n = as_float((params.get("n") or [None])[0], FR24_DEFAULT_BOUNDS[0])
            s = as_float((params.get("s") or [None])[0], FR24_DEFAULT_BOUNDS[1])
            w = as_float((params.get("w") or [None])[0], FR24_DEFAULT_BOUNDS[2])
            e = as_float((params.get("e") or [None])[0], FR24_DEFAULT_BOUNDS[3])

            n = max(-90.0, min(90.0, n))
            s = max(-90.0, min(90.0, s))
            w = max(-180.0, min(180.0, w))
            e = max(-180.0, min(180.0, e))

            data = self._fr24_fetch_feed((n, s, w, e))
            if not data:
                self._send_json({"ok": False, "error": "FlightRadar24 fetch failed"}, status=502)
                return

            flights = self._fr24_extract_flights(data)
            if uk_only:
                def in_uk_airspace(f):
                    try:
                        lat = float(f.get("lat"))
                        lon = float(f.get("lon"))
                    except Exception:
                        return False
                    return (
                        UK_AIRSPACE_BOUNDS["south"] <= lat <= UK_AIRSPACE_BOUNDS["north"]
                        and UK_AIRSPACE_BOUNDS["west"] <= lon <= UK_AIRSPACE_BOUNDS["east"]
                    )
                flights = [
                    f for f in flights
                    if in_uk_airspace(f)
                    or (
                        (not isinstance(f.get("lat"), (int, float)) or not isinstance(f.get("lon"), (int, float)))
                        and (
                            str(f.get("origin") or "").strip().upper() in UK_AIRPORT_IATA
                            or str(f.get("destination") or "").strip().upper() in UK_AIRPORT_IATA
                        )
                    )
                ]

            self._send_json(
                {
                    "ok": True,
                    "bounds": {"n": n, "s": s, "w": w, "e": e},
                    "ukOnly": uk_only,
                    "count": len(flights),
                    "flights": flights,
                    "generatedAt": time.time(),
                }
            )
            return

        if self.path.startswith("/api/flightradar/flight"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            fid = str((params.get("id") or [""])[0] or "").strip()
            if not fid:
                self._send_json({"ok": False, "error": "Missing id"}, status=400)
                return
            include_trail = str((params.get("trail") or ["1"])[0]).strip().lower() not in {"0", "false", "no", "off"}
            details = self._fr24_fetch_details(fid)
            if not details:
                self._send_json({"ok": False, "error": "FlightRadar24 details fetch failed"}, status=502)
                return

            out = {
                "identification": details.get("identification") or {},
                "status": details.get("status") or {},
                "aircraft": details.get("aircraft") or {},
                "airline": details.get("airline") or {},
                "airport": details.get("airport") or {},
                "time": details.get("time") or {},
                "trail": [],
            }
            if include_trail:
                trail = details.get("trail")
                if isinstance(trail, list):
                    out["trail"] = trail[-600:]
            self._send_json({"ok": True, "id": fid, "details": out, "generatedAt": time.time()})
            return

        if self.path.startswith("/flight/schedule"):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query or "")
            callsign = ((params.get("callsign") or [""])[0]).strip().upper()
            icao24 = ((params.get("icao24") or [""])[0]).strip().lower()
            key = os.environ.get("AVIATIONSTACK_API_KEY", "").strip()
            if not key:
                self._send_json(
                    {
                        "ok": False,
                        "reason": "AVIATIONSTACK_API_KEY env var not set",
                        "flight": None,
                    },
                    status=200,
                )
                return
            if not callsign and not icao24:
                self._send_json({"ok": False, "reason": "callsign or icao24 required", "flight": None}, status=400)
                return

            upstream_params = {"access_key": key, "limit": "12"}
            if callsign:
                upstream_params["flight_iata"] = callsign
            upstream_url = f"{AVIATIONSTACK_BASE}/flights?{urlencode(upstream_params)}"
            req = urllib.request.Request(upstream_url)
            req.add_header("Accept", "application/json")
            req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    body = json.loads(resp.read().decode("utf-8", errors="replace"))
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    detail = str(e)
                self._send_json({"ok": False, "reason": f"aviationstack HTTP {e.code}", "detail": detail}, status=502)
                return
            except Exception as e:
                self._send_json({"ok": False, "reason": "aviationstack request failed", "detail": str(e)}, status=502)
                return

            items = body.get("data") if isinstance(body, dict) else []
            if not isinstance(items, list):
                items = []

            def score(item):
                val = 0
                cs = str(item.get("flight", {}).get("iata", "")).upper()
                if callsign and cs == callsign:
                    val += 50
                if item.get("live"):
                    val += 20
                if item.get("flight_status"):
                    val += 10
                return val

            items.sort(key=score, reverse=True)
            top = items[0] if items else None
            if not top:
                self._send_json({"ok": True, "reason": "no schedule match", "flight": None}, status=200)
                return

            dep = top.get("departure") or {}
            arr = top.get("arrival") or {}
            flight_obj = top.get("flight") or {}
            airline = top.get("airline") or {}
            out = {
                "ok": True,
                "flight": {
                    "flight_code": flight_obj.get("iata") or flight_obj.get("icao") or callsign,
                    "status": top.get("flight_status") or "unknown",
                    "airline": airline.get("name") or "",
                    "departure": {
                        "airport": dep.get("airport") or dep.get("iata") or dep.get("icao"),
                        "scheduled": dep.get("scheduled"),
                        "estimated": dep.get("estimated"),
                        "actual": dep.get("actual"),
                        "delay": dep.get("delay"),
                    },
                    "arrival": {
                        "airport": arr.get("airport") or arr.get("iata") or arr.get("icao"),
                        "scheduled": arr.get("scheduled"),
                        "estimated": arr.get("estimated"),
                        "actual": arr.get("actual"),
                        "delay": arr.get("delay"),
                    },
                },
            }
            self._send_json(out, status=200)
            return

        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/dvla/vehicle"):
            api_key = os.environ.get("DVLA_API_KEY", "").strip()
            if not api_key:
                self._send_json({"error": "DVLA_API_KEY env var not set"}, status=500)
                return
            length = 0
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except Exception:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                self._send_json({"error": "Invalid JSON body"}, status=400)
                return
            registration = str(body.get("registrationNumber") or "").upper().replace(" ", "").strip()
            if not registration:
                self._send_json({"error": "registrationNumber is required"}, status=400)
                return

            upstream_url = f"{DVLA_VES_API_BASE}/vehicle-enquiry/v1/vehicles"
            payload = json.dumps({"registrationNumber": registration}).encode("utf-8")
            req = urllib.request.Request(upstream_url, data=payload, method="POST")
            req.add_header("Accept", "application/json")
            req.add_header("Content-Type", "application/json")
            req.add_header("x-api-key", api_key)
            req.add_header("User-Agent", "ControlRoom/1.0 (+https://localhost)")
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    body = resp.read()
                    self.send_response(resp.status)
                    self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(body)
                    return
            except urllib.error.HTTPError as e:
                err_body = e.read() if hasattr(e, "read") else b"{}"
                self._send_json_error(e.code, err_body)
                return
            except Exception as e:
                self._send_json({"error": "DVLA upstream failed", "detail": str(e)}, status=502)
                return

        self._send_json({"error": "Not found"}, status=404)


def main(argv: Optional[list] = None):
    load_env_file()
    config = parse_server_config(argv)

    try:
        os.chdir(config.root)
    except FileNotFoundError:
        print(f"!! Static root {config.root} does not exist", file=sys.stderr)
        sys.exit(2)

    Handler.protocol_version = "HTTP/1.1"
    server = ThreadingHTTPServer((config.host, config.port), Handler)
    print(f"\n{'=' * 72}")
    print("Control Room Server Running")
    print(f"{'=' * 72}")
    print(f"Host:   http://{config.host}:{config.port}")
    print(f"Root:   {config.root}")
    print(f"Proxy:  /ch/* -> {CH_API_BASE}")
    print(f"Proxy:  /tfl/* -> {TFL_API_BASE}")
    print(f"Proxy:  /postcodes/* -> {POSTCODES_API_BASE}")
    print(f"Proxy:  /webtris/* -> {WEBTRIS_API_BASE}")
    print(f"Proxy:  /api/flightradar/flights?n=..&s=..&w=..&e=.. -> {FR24_FEED_URL}")
    print(f"Proxy:  /api/flightradar/flight?id=... -> {FR24_CLICKHANDLER_URL}<id>")
    print(f"Proxy:  /osplaces/postcode?postcode=... -> {OS_PLACES_API_BASE}/postcode")
    print(f"Proxy:  /nre/departures|arrivals?crs=KGX&rows=10 -> {NRE_LDBWS_URL}")
    print(f"Proxy:  /nre/service?service_id=... -> {NRE_LDBWS_URL}")
    print(f"Proxy:  /nre/stations?q=king&limit=20 -> {UK_RAIL_STATIONS_URL}")
    print(f"Proxy:  /geo/search?q=... -> {NOMINATIM_BASE}")
    print(f"Proxy:  /flight/schedule?callsign=BAW130&icao24=... -> {AVIATIONSTACK_BASE}/flights")
    print(f"Proxy:  /dvla/vehicle [POST] -> {DVLA_VES_API_BASE}/vehicle-enquiry/v1/vehicles")
    print(f"Proxy:  /raildata/feeds -> {RAILDATA_API_BASE}/api/feeds")
    print(f"Proxy:  /raildata/kb/<feed> -> {RAILDATA_API_BASE}/api/staticfeeds/* (X-Auth-Token)")
    print("Proxy:  /raildata/disruptions | /raildata/performance?stanoxGroup=... | /raildata/reference?currentVersion=...")
    print("Proxy:  /raildata/service-details?serviceid=... | /raildata/live-board?crs=...")
    print("Proxy:  /raildata/naptan | /raildata/nptg")
    print("Proxy:  /raildata/proxy?url=<full-feed-url>&auth=token|apikey|basic")
    print(f"{'=' * 72}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Control Room server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
