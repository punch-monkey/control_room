import argparse
import json
import re
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse

import requests


API_URL = "https://gran-turismo.fandom.com/api.php"
HEADERS = {"User-Agent": "ControlRoomGranTurismoBuilder/2.0"}
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 1.2

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def log_line(text: str) -> None:
    try:
        print(text)
    except UnicodeEncodeError:
        safe = str(text).encode("ascii", "replace").decode("ascii")
        print(safe)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_JSON = ROOT / "data" / "vehicle_models.json"
IMAGES_DIR = ROOT / "gfx" / "vehicle_images" / "gran_turismo"

COLOR_NAME_TO_RGB = {
    "bianco trofeo": (246, 246, 244),
    "verde montreal": (20, 112, 84),
    "rosso gta": (170, 12, 20),
    "rosso": (196, 30, 58),
    "bianco": (245, 245, 245),
    "nero": (20, 20, 20),
    "argento": (192, 192, 192),
    "grigio": (128, 128, 128),
    "grigio scuro": (80, 84, 88),
    "grigio chiaro": (176, 180, 186),
    "blu": (15, 82, 186),
    "blu scuro": (10, 35, 90),
    "azzurro": (102, 153, 204),
    "verde": (34, 139, 34),
    "giallo": (255, 205, 0),
    "arancio": (235, 105, 35),
    "arancio atlas": (227, 112, 30),
    "marrone": (106, 74, 60),
    "beige": (210, 195, 165),
    "oro": (204, 168, 71),
    "bronzo": (140, 110, 90),
    "silver": (192, 192, 192),
    "white": (245, 245, 245),
    "black": (20, 20, 20),
    "grey": (128, 128, 128),
    "gray": (128, 128, 128),
    "dark gray": (84, 88, 94),
    "light gray": (178, 182, 189),
    "red": (196, 30, 58),
    "blue": (15, 82, 186),
    "green": (34, 139, 34),
    "yellow": (255, 205, 0),
    "orange": (235, 105, 35),
    "brown": (106, 74, 60),
    "gold": (204, 168, 71),
    "bronze": (140, 110, 90),
    "purple": (106, 76, 147),
    "pink": (224, 122, 153),
}


def clean_id(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower())
    return normalized.strip("_")


def clean_text(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"<ref[^>]*>.*?</ref>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<ref[^/>]*/>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    text = re.sub(r"\[\[([^|\]]*\|)?([^\]]+)\]\]", r"\2", text)
    text = text.replace("'''", "").replace("''", "")
    return re.sub(r"\s+", " ", text).strip()


def rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def api_get(params: Dict[str, str]) -> Dict:
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = SESSION.get(API_URL, params=params, timeout=40)
            response.raise_for_status()
            data = response.json()
            if "error" in data:
                raise RuntimeError(f"API error: {data['error']}")
            return data
        except Exception as exc:
            last_exc = exc
            if attempt >= MAX_RETRIES:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"API request failed after {MAX_RETRIES} attempts: {last_exc}")


def iter_category_members(category_title: str) -> Iterable[Dict]:
    cmcontinue = None
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category_title}",
            "cmlimit": "500",
            "format": "json",
        }
        if cmcontinue:
            params["cmcontinue"] = cmcontinue
        payload = api_get(params)
        for item in payload.get("query", {}).get("categorymembers", []):
            yield item
        cmcontinue = payload.get("continue", {}).get("cmcontinue")
        if not cmcontinue:
            break


def get_car_list_pages() -> List[str]:
    pages = []
    for item in iter_category_members("Car_Lists"):
        if int(item.get("ns", -1)) != 0:
            continue
        title = str(item.get("title", "")).strip()
        if title:
            pages.append(title)
    return sorted(set(pages))


def get_links_from_page(page_title: str) -> List[str]:
    payload = api_get(
        {
            "action": "parse",
            "page": page_title,
            "prop": "links",
            "format": "json",
        }
    )
    links = []
    for link in payload.get("parse", {}).get("links", []):
        if int(link.get("ns", -1)) != 0:
            continue
        title = str(link.get("*", "")).strip()
        if title:
            links.append(title)
    return links


def gather_candidate_car_pages(list_pages: List[str]) -> List[str]:
    candidates: Set[str] = set()
    for idx, page in enumerate(list_pages, start=1):
        log_line(f"[lists {idx}/{len(list_pages)}] {page}")
        try:
            links = get_links_from_page(page)
        except Exception as exc:
            log_line(f"  ! Failed to read links: {exc}")
            continue
        for title in links:
            t = title.lower()
            if t.startswith("category:") or t.startswith("template:") or t.startswith("help:"):
                continue
            if "gran turismo wiki" in t:
                continue
            candidates.add(title)
        time.sleep(0.08)
    return sorted(candidates)


def fetch_wikitext(page_title: str) -> str:
    payload = api_get(
        {
            "action": "parse",
            "page": page_title,
            "prop": "wikitext",
            "format": "json",
        }
    )
    return payload.get("parse", {}).get("wikitext", {}).get("*", "")


def extract_template_block(wikitext: str, template_prefix: str) -> str:
    start = wikitext.find(template_prefix)
    if start < 0:
        return ""
    depth = 0
    i = start
    while i < len(wikitext) - 1:
        pair = wikitext[i : i + 2]
        if pair == "{{":
            depth += 1
            i += 2
            continue
        if pair == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                return wikitext[start:i]
            continue
        i += 1
    return ""


def parse_infobox(block: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not block:
        return values
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|") or "=" not in line:
            continue
        key, raw = line[1:].split("=", 1)
        key = key.strip()
        if not key:
            continue
        values[key] = clean_text(raw)
    return values


def parse_colors(wikitext: str) -> List[str]:
    section = re.search(r"==\s*Colors\s*==(.*?)(?:\n==|\Z)", wikitext, flags=re.IGNORECASE | re.DOTALL)
    if not section:
        return []
    out: List[str] = []
    for line in section.group(1).splitlines():
        line = line.strip()
        if not line.startswith("*"):
            continue
        color = clean_text(line[1:])
        if color:
            out.append(color)
    # preserve order, remove duplicates
    seen = set()
    deduped = []
    for c in out:
        if c in seen:
            continue
        seen.add(c)
        deduped.append(c)
    return deduped


def infer_color_rgb(color_name: str) -> Optional[Tuple[int, int, int]]:
    key = re.sub(r"\s+", " ", str(color_name or "").strip().lower())
    if not key:
        return None
    if key in COLOR_NAME_TO_RGB:
        return COLOR_NAME_TO_RGB[key]

    # Token fallback for mixed names like "Nero Daytona Metallic"
    tokens = re.findall(r"[a-z]+", key)
    for i in range(len(tokens), 0, -1):
        phrase = " ".join(tokens[:i])
        if phrase in COLOR_NAME_TO_RGB:
            return COLOR_NAME_TO_RGB[phrase]
    for token in tokens:
        if token in COLOR_NAME_TO_RGB:
            return COLOR_NAME_TO_RGB[token]
    return None


def build_color_entries(color_names: List[str]) -> List[Dict]:
    entries: List[Dict] = []
    for name in color_names:
        rgb = infer_color_rgb(name)
        if rgb is None:
            entries.append({"name": name, "rgb": None, "hex": None, "confidence": "unknown"})
            continue
        entries.append(
            {
                "name": name,
                "rgb": [int(rgb[0]), int(rgb[1]), int(rgb[2])],
                "hex": rgb_to_hex(rgb),
                "confidence": "matched",
            }
        )
    return entries


def resolve_file_url(filename_or_title: str) -> Optional[str]:
    raw = str(filename_or_title or "").strip()
    if not raw:
        return None
    title = raw if raw.lower().startswith("file:") else f"File:{raw}"
    payload = api_get(
        {
            "action": "query",
            "titles": title,
            "prop": "imageinfo",
            "iiprop": "url",
            "format": "json",
        }
    )
    pages = payload.get("query", {}).get("pages", {})
    for page in pages.values():
        info = page.get("imageinfo")
        if info and isinstance(info, list):
            return info[0].get("url")
    return None


def fetch_page_thumbnail(page_title: str) -> Optional[str]:
    payload = api_get(
        {
            "action": "query",
            "titles": page_title,
            "prop": "pageimages",
            "pithumbsize": "1000",
            "format": "json",
        }
    )
    pages = payload.get("query", {}).get("pages", {})
    for page in pages.values():
        thumb = page.get("thumbnail", {})
        src = thumb.get("source")
        if src:
            return src
    return None


def download_image(url: str, entity_id: str, output_dir: Path) -> Optional[str]:
    if not url:
        return None
    output_dir.mkdir(parents=True, exist_ok=True)
    parsed = urlparse(url)
    ext = Path(parsed.path).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        ext = ".jpg"
    out_file = output_dir / f"{entity_id}{ext}"
    if out_file.exists() and out_file.stat().st_size > 0:
        return out_file.relative_to(ROOT).as_posix()
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = SESSION.get(url, timeout=60)
            response.raise_for_status()
            out_file.write_bytes(response.content)
            return out_file.relative_to(ROOT).as_posix()
        except Exception as exc:
            last_exc = exc
            if attempt >= MAX_RETRIES:
                break
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    log_line(f"  ! Image download failed after {MAX_RETRIES} attempts: {last_exc}")
    return None


def build_record(page_title: str, wikitext: str, image_output_dir: Path) -> Optional[Tuple[str, Dict]]:
    infobox_block = extract_template_block(wikitext, "{{Infobox/Car")
    if not infobox_block:
        return None

    info = parse_infobox(infobox_block)
    entity_id = clean_id(page_title)
    if not entity_id:
        return None

    image_title = info.get("image", "")
    image_url = resolve_file_url(image_title) if image_title else None
    if not image_url:
        image_url = fetch_page_thumbnail(page_title)

    local_image = download_image(image_url, entity_id, image_output_dir) if image_url else None

    specs = {
        "manufacturer": info.get("manufacturer", ""),
        "model": info.get("model", ""),
        "year": info.get("year", ""),
        "type": info.get("type", ""),
        "origin": info.get("origin", ""),
        "engine_code": info.get("engcode", ""),
        "displacement": info.get("disp", ""),
        "displacement_unit": info.get("dispunit", ""),
        "engine_type": info.get("engine", ""),
        "aspiration": info.get("aspiration", ""),
        "power": info.get("power", ""),
        "power_unit": info.get("powerunit", ""),
        "torque": info.get("torque", ""),
        "torque_unit": info.get("torqueunit", ""),
        "layout": info.get("layout", ""),
        "drivetrain": info.get("drivetrain", ""),
        "gears": info.get("gears", ""),
        "weight": info.get("weight", ""),
        "weight_unit": info.get("weightunit", ""),
        "balance_front": info.get("front", ""),
        "performance_points": info.get("pp2", "") or info.get("pp", ""),
        "length": info.get("length", ""),
        "width": info.get("width", ""),
        "height": info.get("height", ""),
    }

    # Remove blank values to keep output lean.
    specs = {k: v for k, v in specs.items() if str(v).strip()}
    colors = parse_colors(wikitext)
    color_entries = build_color_entries(colors)

    record = {
        "label": page_title,
        "entity_type": "vehicle_model",
        "source": "gran_turismo_fandom",
        "source_page": f"https://gran-turismo.fandom.com/wiki/{page_title.replace(' ', '_')}",
        "image_url": image_url,
        "local_image_path": local_image,
        "specs": specs,
        "colors": colors,
        "color_entries": color_entries,
    }
    return entity_id, record


def run(limit: int = 0) -> None:
    log_line("\n=== Gran Turismo Vehicle Model Builder ===\n")
    log_line("Fetching list pages from Category:Car_Lists...")
    list_pages = get_car_list_pages()
    log_line(f"Found {len(list_pages)} list pages")

    candidates = gather_candidate_car_pages(list_pages)
    log_line(f"\nCandidate page count: {len(candidates)}")
    if limit > 0:
        candidates = candidates[:limit]
        log_line(f"Applying limit: {limit}")

    database: Dict[str, Dict] = {}
    if OUTPUT_JSON.exists():
        try:
            existing = json.loads(OUTPUT_JSON.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                database = existing
                log_line(f"Loaded existing records: {len(database)}")
        except Exception:
            pass
    processed = 0
    kept = 0
    skipped = 0
    for title in candidates:
        processed += 1
        log_line(f"[cars {processed}/{len(candidates)}] {title}")
        try:
            wikitext = fetch_wikitext(title)
            built = build_record(title, wikitext, IMAGES_DIR)
        except Exception as exc:
            log_line(f"  ! Failed: {exc}")
            skipped += 1
            continue
        if not built:
            skipped += 1
            continue
        entity_id, record = built
        database[entity_id] = record
        kept += 1
        time.sleep(0.08)

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps(database, indent=2, ensure_ascii=False), encoding="utf-8")

    log_line("\n=== COMPLETE ===")
    log_line(f"Processed: {processed}")
    log_line(f"Saved: {kept}")
    log_line(f"Skipped: {skipped}")
    log_line(f"JSON: {OUTPUT_JSON}")
    log_line(f"Images: {IMAGES_DIR}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Gran Turismo car model records with specs/colors/images.")
    parser.add_argument("--limit", type=int, default=0, help="Only process first N candidate pages (0 = all)")
    args = parser.parse_args()
    run(limit=max(0, int(args.limit or 0)))


if __name__ == "__main__":
    main()
