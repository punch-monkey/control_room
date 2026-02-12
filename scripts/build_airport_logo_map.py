import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AIRPORT_ICONS_DIR = ROOT / "gfx" / "airport_icons"
OUTPUT_PATH = ROOT / "data" / "airport_logo_map.json"


# High-confidence mappings by airport code.
IATA_TO_FILE = {
    "BHD": "George_Best_Belfast_City_Airport.png",
    "BHX": "BirminghamAirportLogo.png",
    "BQH": "BigginHillAirport.png",
    "BRS": "Bristol_Airport_logo_vector.png",
    "CBG": "CambridgeAirport.png",
    "CWL": "CardiffAirportLogo.png",
    "EDI": "EdinburghAirport.png",
    "JER": "JER_airport_logo.png",
    "LCY": "London_City_Airport_logo.png",
    "LGW": "LGW_airport_logo.png",
    "LHR": "Heathrow_Logo_2013.png",
    "LTN": "London_Luton_Airport_logo_2014.png",
    "MAN": "Manchester_Airports_Group_logo.png",
}

ICAO_TO_FILE = {
    "EGAC": "George_Best_Belfast_City_Airport.png",
    "EGBB": "BirminghamAirportLogo.png",
    "EGCC": "Manchester_Airports_Group_logo.png",
    "EGFF": "CardiffAirportLogo.png",
    "EGGD": "Bristol_Airport_logo_vector.png",
    "EGGW": "London_Luton_Airport_logo_2014.png",
    "EGJJ": "JER_airport_logo.png",
    "EGKB": "BigginHillAirport.png",
    "EGKK": "LGW_airport_logo.png",
    "EGLC": "London_City_Airport_logo.png",
    "EGLL": "Heathrow_Logo_2013.png",
    "EGPH": "EdinburghAirport.png",
    "EGSC": "CambridgeAirport.png",
}

NAME_HINTS = [
    (r"\bBIGGIN\b.*\bHILL\b", "BigginHillAirport.png"),
    (r"\bBIRMINGHAM\b", "BirminghamAirportLogo.png"),
    (r"\bBRISTOL\b", "Bristol_Airport_logo_vector.png"),
    (r"\bCAMBRIDGE\b", "CambridgeAirport.png"),
    (r"\bCARDIFF\b", "CardiffAirportLogo.png"),
    (r"\bEDINBURGH\b", "EdinburghAirport.png"),
    (r"\bGATWICK\b", "Gatwick_Airport_logo.png"),
    (r"\bHEATHROW\b", "Heathrow_Logo_2013.png"),
    (r"\bJERSEY\b", "JER_airport_logo.png"),
    (r"\bLONDON\b.*\bCITY\b", "London_City_Airport_logo.png"),
    (r"\bLUTON\b", "London_Luton_Airport_logo_2014.png"),
    (r"\bMANCHESTER\b", "Manchester_Airports_Group_logo.png"),
    (r"\bBELFAST\b.*\bCITY\b", "George_Best_Belfast_City_Airport.png"),
]


def logo_path(file_name: str) -> str:
    return f"gfx/airport_icons/{file_name}"


def exists_or_warn(file_name: str) -> bool:
    p = AIRPORT_ICONS_DIR / file_name
    if p.exists():
        return True
    print(f"Warning: missing logo file {p}")
    return False


def main() -> None:
    if not AIRPORT_ICONS_DIR.exists():
        raise FileNotFoundError(f"Missing airport icons directory: {AIRPORT_ICONS_DIR}")

    iata = {}
    for code, fn in sorted(IATA_TO_FILE.items()):
        if exists_or_warn(fn):
            iata[code] = logo_path(fn)

    icao = {}
    for code, fn in sorted(ICAO_TO_FILE.items()):
        if exists_or_warn(fn):
            icao[code] = logo_path(fn)

    hints = []
    for pattern, fn in NAME_HINTS:
        if not exists_or_warn(fn):
            continue
        # Validate regex at build time.
        re.compile(pattern)
        hints.append({"pattern": pattern, "logo": logo_path(fn)})

    payload = {"iata": iata, "icao": icao, "name_hints": hints}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote airport logo map: {OUTPUT_PATH}")
    print(f"IATA matches: {len(iata)} | ICAO matches: {len(icao)} | Name hints: {len(hints)}")


if __name__ == "__main__":
    main()
