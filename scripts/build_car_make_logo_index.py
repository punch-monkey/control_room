import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASET_ROOT = ROOT / "gfx" / "car-logos-dataset-master" / "car-logos-dataset-master"
MAIN_DATA_PATH = DATASET_ROOT / "logos" / "data.json"
LOCAL_META_PATH = DATASET_ROOT / "local-logos" / "metadata.json"
OUTPUT_PATH = ROOT / "data" / "car_make_logo_index.json"


ALIASES = {
    "ALFAROMEO": "alfa-romeo",
    "ASTONMARTIN": "aston-martin",
    "DSAUTOMOBILES": "ds",
    "GENERALMOTORS": "gm",
    "LANDROVER": "land-rover",
    "MERCEDES": "mercedes-benz",
    "MERCEDESBENZ": "mercedes-benz",
    "MGB": "mg",
    "ROLLSROYCE": "rolls-royce",
    "VAUXHALL": "opel",
}


def normalize_key(raw: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(raw or "").lower())


def main() -> None:
    if not MAIN_DATA_PATH.exists():
        raise FileNotFoundError(f"Missing car logo metadata: {MAIN_DATA_PATH}")

    items = json.loads(MAIN_DATA_PATH.read_text(encoding="utf-8"))
    index = {}
    slug_to_path = {}

    for item in items:
        name = str(item.get("name", "")).strip()
        slug = str(item.get("slug", "")).strip()
        if not slug:
            continue
        logo_file = DATASET_ROOT / "logos" / "optimized" / f"{slug}.png"
        if not logo_file.exists():
            continue
        rel = logo_file.relative_to(ROOT).as_posix()
        slug_to_path[slug] = rel
        nk = normalize_key(name)
        if nk:
            index[nk] = rel
        sk = normalize_key(slug)
        if sk:
            index[sk] = rel

    if LOCAL_META_PATH.exists():
        local_items = json.loads(LOCAL_META_PATH.read_text(encoding="utf-8"))
        for item in local_items:
            name = str(item.get("name", "")).strip()
            file_name = str(item.get("file", "")).strip()
            if not file_name:
                continue
            logo_file = DATASET_ROOT / "local-logos" / file_name
            if not logo_file.exists():
                continue
            rel = logo_file.relative_to(ROOT).as_posix()
            nk = normalize_key(name)
            if nk:
                index[nk] = rel

    for alias_key, slug in ALIASES.items():
        rel = slug_to_path.get(slug)
        if rel:
            index[normalize_key(alias_key)] = rel

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(dict(sorted(index.items())), indent=2), encoding="utf-8")
    print(f"Wrote car make logo index: {OUTPUT_PATH}")
    print(f"Entries: {len(index)}")


if __name__ == "__main__":
    main()
