import requests
import json
import os

# ==========================================
# SETTINGS
# ==========================================

OUTPUT_JSON = r"C:\Users\44752\Desktop\Control Room\data\vehicle_entities.json"

LIMIT = 200  # increase later if needed

USER_AGENT = "ControlRoomVehicleEntityBuilder/1.0"

# ==========================================

headers = {
    "User-Agent": USER_AGENT
}

os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)


# ==========================================
# QUERY WIKIDATA
# ==========================================

def fetch_vehicle_entities(limit):

    print("Querying Wikidata...")

    query = f"""
    SELECT ?manufacturer ?manufacturerLabel ?logo ?image WHERE {{
      ?manufacturer wdt:P31/wdt:P279* wd:Q786820.
      
      OPTIONAL {{ ?manufacturer wdt:P154 ?logo. }}
      OPTIONAL {{ ?manufacturer wdt:P18 ?image. }}
      
      SERVICE wikibase:label {{
        bd:serviceParam wikibase:language "en".
      }}
    }}
    LIMIT {limit}
    """

    url = "https://query.wikidata.org/sparql"

    r = requests.get(
        url,
        params={"query": query, "format": "json"},
        headers=headers
    )

    return r.json()["results"]["bindings"]


# ==========================================
# CONVERT TO CLEAN JSON STRUCTURE
# ==========================================

def clean_id(name):

    return (
        name.lower()
        .replace(" ", "_")
        .replace("-", "_")
        .replace(".", "")
    )


def build_database(entries):

    database = {}

    for entry in entries:

        name = entry["manufacturerLabel"]["value"]

        entity_id = clean_id(name)

        logo_url = entry.get("logo", {}).get("value")
        image_url = entry.get("image", {}).get("value")

        database[entity_id] = {
            "label": name,
            "logo_url": logo_url,
            "image_url": image_url,
            "entity_type": "vehicle_manufacturer",
            "source": "wikidata"
        }

    return database


# ==========================================
# SAVE JSON
# ==========================================

def save_json(database):

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:

        json.dump(database, f, indent=2, ensure_ascii=False)

    print(f"\nSaved: {OUTPUT_JSON}")


# ==========================================
# MAIN
# ==========================================

def run():

    print("\n=== VEHICLE ENTITY URL BUILDER ===\n")

    entries = fetch_vehicle_entities(LIMIT)

    print(f"Found {len(entries)} manufacturers")

    database = build_database(entries)

    save_json(database)

    print("\n=== COMPLETE ===\n")


# ==========================================

if __name__ == "__main__":
    run()
