import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
XREF_DIR = ROOT / "data" / "dvla_icon_crossref"
COVERED_CSV = XREF_DIR / "dvla_vehicle_icon_covered.csv"
WEAK_CSV = XREF_DIR / "dvla_vehicle_icon_weak_matches.csv"
OUT_JSON = ROOT / "data" / "dvla_vehicle_icon_lookup.json"

# Conservative thresholds so we only auto-apply solid matches.
MIN_COVERED_SCORE = 0.50
MIN_WEAK_SCORE = 0.60
MIN_DEFAULT_SCORE = 0.52


MAKE_ALIAS = {
    "mercedes benz": "mercedes",
    "mercedes-benz": "mercedes",
    "mercedes amg": "mercedes",
    "amg mercedes": "mercedes",
    "alfa romeo": "alfaromeo",
    "land rover": "landrover",
    "range rover": "landrover",
    "rolls royce": "rollsroyce",
    "vw": "volkswagen",
}


def normalize_make_key(text: str) -> str:
    base = "".join(ch.lower() if ch.isalnum() else " " for ch in str(text or ""))
    toks = [t for t in base.split() if t]
    if not toks:
        return ""
    joined = " ".join(toks)
    if joined in MAKE_ALIAS:
        return MAKE_ALIAS[joined]
    if len(toks) >= 2:
        two = " ".join(toks[:2])
        if two in MAKE_ALIAS:
            return MAKE_ALIAS[two]
    return "".join(toks)


def safe_int(text: str) -> int:
    try:
        return int(float(str(text or "0").strip()))
    except Exception:
        return 0


def safe_float(text: str) -> float:
    try:
        return float(str(text or "0").strip())
    except Exception:
        return 0.0


def consume_rows(
    path: Path,
    min_score: float,
    by_make_year: Dict[str, Dict[int, Dict[str, object]]],
    by_make_default: Dict[str, Dict[str, object]],
) -> int:
    if not path.exists():
        return 0

    rows_used = 0
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            icon_path = str(row.get("best_icon_path", "")).strip()
            if not icon_path.startswith("gfx/vehicle_icons/"):
                continue

            make_key = normalize_make_key(row.get("make", ""))
            if not make_key:
                continue

            score = safe_float(row.get("score", "0"))
            if score < min_score:
                continue

            year = safe_int(row.get("year", "0"))
            fleet = safe_int(row.get("fleet_estimate", "0"))
            weight = max(1.0, float(fleet) * max(score, 0.01))
            label = str(row.get("best_icon_label", "")).strip()

            if year:
                slot = by_make_year[make_key].setdefault(
                    year,
                    {"icon": icon_path, "label": label, "weight": 0.0, "score_weight": 0.0, "samples": 0},
                )
                if slot["icon"] != icon_path:
                    # Compete by total weighted support.
                    cand = weight
                    cur = float(slot["weight"])
                    if cand > cur:
                        slot["icon"] = icon_path
                        slot["label"] = label
                        slot["weight"] = cand
                        slot["score_weight"] = cand * score
                    else:
                        slot["weight"] = cur + cand
                        slot["score_weight"] = float(slot["score_weight"]) + cand * score
                else:
                    slot["weight"] = float(slot["weight"]) + weight
                    slot["score_weight"] = float(slot["score_weight"]) + weight * score
                slot["samples"] = int(slot["samples"]) + 1

            dslot = by_make_default.setdefault(
                make_key,
                {"icon": icon_path, "label": label, "weight": 0.0, "score_weight": 0.0, "samples": 0},
            )
            if dslot["icon"] != icon_path:
                if weight > float(dslot["weight"]):
                    dslot["icon"] = icon_path
                    dslot["label"] = label
                    dslot["weight"] = weight
                    dslot["score_weight"] = weight * score
                else:
                    dslot["weight"] = float(dslot["weight"]) + weight
                    dslot["score_weight"] = float(dslot["score_weight"]) + weight * score
            else:
                dslot["weight"] = float(dslot["weight"]) + weight
                dslot["score_weight"] = float(dslot["score_weight"]) + weight * score
            dslot["samples"] = int(dslot["samples"]) + 1

            rows_used += 1
    return rows_used


def avg_score(node: Dict[str, object]) -> float:
    w = float(node.get("weight", 0.0))
    if w <= 0:
        return 0.0
    return float(node.get("score_weight", 0.0)) / w


def main() -> None:
    by_make_year: Dict[str, Dict[int, Dict[str, object]]] = defaultdict(dict)
    by_make_default: Dict[str, Dict[str, object]] = {}

    used_covered = consume_rows(COVERED_CSV, MIN_COVERED_SCORE, by_make_year, by_make_default)
    used_weak = consume_rows(WEAK_CSV, MIN_WEAK_SCORE, by_make_year, by_make_default)

    by_make_out: Dict[str, Dict[str, object]] = {}
    for make, years in by_make_year.items():
        default = by_make_default.get(make)
        if not default:
            continue

        default_score = avg_score(default)
        if default_score < MIN_DEFAULT_SCORE:
            continue

        year_out: Dict[str, Dict[str, object]] = {}
        for year, data in years.items():
            year_out[str(year)] = {
                "icon": str(data["icon"]),
                "label": str(data.get("label", "")),
                "score": round(avg_score(data), 4),
                "samples": int(data.get("samples", 0)),
            }

        by_make_out[make] = {
            "default_icon": str(default["icon"]),
            "default_label": str(default.get("label", "")),
            "default_score": round(default_score, 4),
            "samples": int(default.get("samples", 0)),
            "years": year_out,
        }

    payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "covered_csv": str(COVERED_CSV),
            "weak_csv": str(WEAK_CSV),
        },
        "thresholds": {
            "min_covered_score": MIN_COVERED_SCORE,
            "min_weak_score": MIN_WEAK_SCORE,
            "min_default_score": MIN_DEFAULT_SCORE,
        },
        "rows_used": {
            "covered": used_covered,
            "weak": used_weak,
        },
        "make_count": len(by_make_out),
        "by_make": by_make_out,
    }

    OUT_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Lookup written: {OUT_JSON}")
    print(f"Makes: {len(by_make_out)}")
    print(f"Rows used: covered={used_covered}, weak={used_weak}")


if __name__ == "__main__":
    main()

