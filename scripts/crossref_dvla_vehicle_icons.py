import csv
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
DVLA_CSV = ROOT / "data" / "DVLA" / "df_VEH0124.csv"
VEHICLE_MODELS_JSON = ROOT / "data" / "vehicle_models.json"
ICON_DIR = ROOT / "gfx" / "vehicle_icons" / "gran_turismo_200_circle"
OUT_DIR = ROOT / "data" / "dvla_icon_crossref"

MISSING_THRESHOLD = 0.18
WEAK_THRESHOLD = 0.42


MAKE_ALIAS = {
    "mercedes benz": "mercedes",
    "mercedes-benz": "mercedes",
    "mercedes amg": "mercedes",
    "amg mercedes": "mercedes",
    "alfa romeo": "alfa romeo",
    "land rover": "land rover",
    "range rover": "land rover",
    "aston martin": "aston martin",
    "rolls royce": "rolls royce",
    "vauxhall": "vauxhall",
    "vw": "volkswagen",
}

RACE_TOKENS = {
    "race",
    "racing",
    "rally",
    "touring",
    "gt3",
    "gt4",
    "gr3",
    "gr4",
    "formula",
    "nascar",
    "lm",
    "lemans",
    "vision",
    "concept",
    "prototype",
    "drift",
    "supergt",
    "jgtc",
    "pikes",
    "f1",
}

CLASS_STOPWORDS = {
    "and",
    "the",
    "auto",
    "automatic",
    "manual",
    "diesel",
    "petrol",
    "hybrid",
    "ev",
    "electric",
    "se",
    "sel",
    "sport",
    "line",
    "premium",
    "amg",
    "edition",
    "isg",
    "hev",
    "phev",
    "awd",
    "fwd",
    "rwd",
    "cdi",
    "tsi",
    "tdi",
    "d",
    "t",
    "s",
}


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())


def tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", normalize_space(text).lower())


def canonical_make(text: str) -> str:
    toks = tokenize(text)
    if not toks:
        return ""
    joined = " ".join(toks)
    if joined in MAKE_ALIAS:
        return MAKE_ALIAS[joined]
    if len(toks) >= 2:
        two = " ".join(toks[:2])
        if two in MAKE_ALIAS:
            return MAKE_ALIAS[two]
    return joined


def parse_int_like(text: str) -> int:
    s = str(text or "").strip()
    if not s or s.startswith("["):
        return 0
    try:
        return int(float(s))
    except Exception:
        return 0


def year_from_key(key: str) -> Optional[int]:
    toks = tokenize(key)
    if not toks:
        return None
    # Prefer full 4-digit years in sensible range.
    years = [int(t) for t in toks if len(t) == 4 and t.isdigit() and 1900 <= int(t) <= 2030]
    if years:
        return years[-1]
    # Fallback for trailing 2-digit year fragments in filenames (e.g., _02).
    if len(toks[-1]) == 2 and toks[-1].isdigit():
        y = int(toks[-1])
        return 1900 + y if y >= 70 else 2000 + y
    return None


def overlap_score(query_tokens: List[str], target_tokens: List[str]) -> float:
    if not query_tokens or not target_tokens:
        return 0.0
    q = set(query_tokens)
    t = set(target_tokens)
    return len(q & t) / max(1, len(q))


def looks_race_or_special(tokens: List[str]) -> bool:
    t = set(tokens)
    if t & RACE_TOKENS:
        return True
    return any(tok.startswith("gr") and tok[2:].isdigit() for tok in t)


def extract_family_tokens(make: str, genmodel: str, model: str) -> List[str]:
    text = f"{make} {genmodel} {model}"
    toks = tokenize(text)
    make_toks = set(tokenize(canonical_make(make)))
    out: List[str] = []
    for t in toks:
        if t in make_toks or t in CLASS_STOPWORDS:
            continue
        if len(t) <= 1:
            continue
        out.append(t)
    # Keep first distinctive tokens and class-like combos (e.g. e class).
    dedup: List[str] = []
    seen = set()
    for t in out:
        if t in seen:
            continue
        seen.add(t)
        dedup.append(t)
    return dedup[:6]


@dataclass
class IconEntry:
    icon_file: str
    icon_path: str
    key: str
    label: str
    make_canonical: str
    make_tokens: List[str]
    model_tokens: List[str]
    year: Optional[int]
    family_tokens: List[str]
    race_like: bool


def load_icon_catalog() -> List[IconEntry]:
    with VEHICLE_MODELS_JSON.open("r", encoding="utf-8") as f:
        vehicle_models = json.load(f)

    icon_files = {p.stem: p.name for p in ICON_DIR.glob("*.png")}

    entries: List[IconEntry] = []
    for key, info in vehicle_models.items():
        icon_name = icon_files.get(key)
        if not icon_name:
            continue

        specs = info.get("specs", {}) if isinstance(info, dict) else {}
        manufacturer = normalize_space(specs.get("manufacturer", ""))
        model = normalize_space(specs.get("model", ""))
        label = normalize_space(info.get("label", key))

        make_text = manufacturer or label.split(" ", 1)[0]
        make_can = canonical_make(make_text)
        model_text = model or label

        entries.append(
            IconEntry(
                icon_file=icon_name,
                icon_path=f"gfx/vehicle_icons/gran_turismo_200_circle/{icon_name}",
                key=key,
                label=label,
                make_canonical=make_can,
                make_tokens=tokenize(make_can),
                model_tokens=tokenize(f"{model_text} {label} {key}"),
                year=parse_int_like(specs.get("year", "")) or year_from_key(key),
                family_tokens=extract_family_tokens(make_text, model, label),
                race_like=looks_race_or_special(tokenize(f"{key} {label} {model_text}")),
            )
        )
    return entries


def build_make_index(entries: Iterable[IconEntry]) -> Dict[str, List[IconEntry]]:
    by_make: Dict[str, List[IconEntry]] = defaultdict(list)
    for e in entries:
        by_make[e.make_canonical].append(e)
    return by_make


def iter_dvla_variants() -> Iterable[Dict[str, object]]:
    agg: Dict[Tuple[str, str, str, int], Dict[str, object]] = {}
    with DVLA_CSV.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            body = normalize_space(row.get("BodyType", "")).lower()
            if body != "cars":
                continue

            make = normalize_space(row.get("Make", ""))
            genmodel = normalize_space(row.get("GenModel", ""))
            model = normalize_space(row.get("Model", ""))
            year = parse_int_like(row.get("YearManufacture", "")) or parse_int_like(row.get("YearFirstUsed", ""))

            if not make or not (genmodel or model):
                continue

            latest_count = parse_int_like(row.get("2024", "")) + parse_int_like(row.get("2023", ""))
            key = (make, genmodel, model, year)
            item = agg.get(key)
            if item is None:
                agg[key] = {
                    "make": make,
                    "genmodel": genmodel,
                    "model": model,
                    "year": year,
                    "fleet_estimate": latest_count,
                    "rows": 1,
                }
            else:
                item["fleet_estimate"] = int(item["fleet_estimate"]) + latest_count
                item["rows"] = int(item["rows"]) + 1

    return agg.values()


def score_variant_to_icon(variant: Dict[str, object], icon: IconEntry) -> Tuple[float, Dict[str, float]]:
    make_can = canonical_make(str(variant.get("make", "")))
    make_toks = tokenize(make_can)
    icon_make_toks = icon.make_tokens
    make_score = overlap_score(make_toks, icon_make_toks)

    gen_toks = tokenize(str(variant.get("genmodel", "")))
    model_toks = tokenize(str(variant.get("model", "")))
    icon_model_toks = icon.model_tokens

    gen_score = overlap_score(gen_toks, icon_model_toks)
    model_score = overlap_score(model_toks, icon_model_toks)
    family_q = extract_family_tokens(str(variant.get("make", "")), str(variant.get("genmodel", "")), str(variant.get("model", "")))
    family_score = overlap_score(family_q, icon.family_tokens)

    v_year = int(variant.get("year") or 0)
    if v_year and icon.year:
        year_score = max(0.0, 1.0 - abs(v_year - icon.year) / 15.0)
    else:
        year_score = 0.25

    variant_tokens = tokenize(f"{variant.get('genmodel', '')} {variant.get('model', '')}")
    variant_race_like = looks_race_or_special(variant_tokens)

    # Require make similarity; heavily weight family/gen-model for practical matching.
    score = (
        (make_score * 0.42)
        + (family_score * 0.28)
        + (gen_score * 0.15)
        + (model_score * 0.10)
        + (year_score * 0.05)
    )

    # Penalize race/special icon suggestions for standard DVLA road vehicles.
    if icon.race_like and not variant_race_like:
        score -= 0.16

    # Penalize very large year gaps when both years exist.
    if v_year and icon.year and abs(v_year - icon.year) > 20:
        score -= 0.08

    score = max(0.0, min(1.0, score))
    return score, {
        "make": make_score,
        "family": family_score,
        "genmodel": gen_score,
        "model": model_score,
        "year": year_score,
    }


def classify(score: float, has_make_candidates: bool) -> str:
    if not has_make_candidates:
        return "clearly_missing"
    if score < MISSING_THRESHOLD:
        return "clearly_missing"
    if score < WEAK_THRESHOLD:
        return "weak_match"
    return "covered"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icons = load_icon_catalog()
    by_make = build_make_index(icons)

    results: List[Dict[str, object]] = []
    for variant in iter_dvla_variants():
        make = str(variant.get("make", ""))
        make_can = canonical_make(make)
        candidates = by_make.get(make_can, [])

        best_score = -1.0
        best_icon: Optional[IconEntry] = None
        best_parts = {"make": 0.0, "family": 0.0, "genmodel": 0.0, "model": 0.0, "year": 0.0}

        if not candidates:
            # Fallback: compare against all icons with any make token overlap.
            make_toks = set(tokenize(make_can))
            candidates = [e for e in icons if make_toks & set(e.make_tokens)]

        for icon in candidates:
            score, parts = score_variant_to_icon(variant, icon)
            if score > best_score:
                best_score = score
                best_icon = icon
                best_parts = parts

        status = classify(best_score if best_score > 0 else 0.0, bool(candidates))
        results.append(
            {
                "status": status,
                "score": round(max(best_score, 0.0), 4),
                "make": make,
                "genmodel": variant.get("genmodel", ""),
                "model": variant.get("model", ""),
                "year": int(variant.get("year") or 0),
                "fleet_estimate": int(variant.get("fleet_estimate") or 0),
                "best_icon_file": best_icon.icon_file if best_icon else "",
                "best_icon_path": best_icon.icon_path if best_icon else "",
                "best_icon_label": best_icon.label if best_icon else "",
                "match_make": round(best_parts["make"], 4),
                "match_family": round(best_parts["family"], 4),
                "match_genmodel": round(best_parts["genmodel"], 4),
                "match_model": round(best_parts["model"], 4),
                "match_year": round(best_parts["year"], 4),
            }
        )

    results.sort(key=lambda x: (x["status"], -int(x["fleet_estimate"]), float(x["score"])))

    summary = defaultdict(int)
    for r in results:
        summary[str(r["status"])] += 1

    (OUT_DIR / "dvla_vehicle_icon_coverage.json").write_text(
        json.dumps(
            {
                "source_dvla": str(DVLA_CSV),
                "source_icons": str(ICON_DIR),
                "thresholds": {
                    "clearly_missing_below": MISSING_THRESHOLD,
                    "weak_match_below": WEAK_THRESHOLD,
                },
                "summary": dict(summary),
                "total_variants": len(results),
                "results": results,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    def write_csv(path: Path, rows: List[Dict[str, object]]) -> None:
        if not rows:
            path.write_text("", encoding="utf-8")
            return
        cols = list(rows[0].keys())
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=cols)
            writer.writeheader()
            writer.writerows(rows)

    missing = [r for r in results if r["status"] == "clearly_missing"]
    weak = [r for r in results if r["status"] == "weak_match"]
    covered = [r for r in results if r["status"] == "covered"]

    write_csv(OUT_DIR / "dvla_vehicle_icon_missing.csv", missing)
    write_csv(OUT_DIR / "dvla_vehicle_icon_weak_matches.csv", weak)
    write_csv(OUT_DIR / "dvla_vehicle_icon_covered.csv", covered)

    # Prioritized shortlist: biggest fleet impact first.
    missing_top = sorted(missing, key=lambda r: int(r["fleet_estimate"]), reverse=True)[:250]
    write_csv(OUT_DIR / "dvla_vehicle_icon_missing_top250.csv", missing_top)

    print("Cross-reference complete")
    print(f"Total variants: {len(results)}")
    print(f"Covered: {len(covered)}")
    print(f"Weak: {len(weak)}")
    print(f"Clearly missing: {len(missing)}")
    print(f"Output directory: {OUT_DIR}")


if __name__ == "__main__":
    main()
