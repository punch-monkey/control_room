import requests
import os
import io
from PIL import Image

# =====================================================
# USER SETTINGS
# =====================================================

WIKIPEDIA_CATEGORY = "Logos_of_airports_in_the_United_Kingdom"

OUTPUT_FOLDER = r"C:\Users\44752\Desktop\Control Room\GFX\airport_icons"

ICON_SIZE = 200

USER_AGENT = "ControlRoomIconPipeline/1.0"

# =====================================================

WIKI_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

headers = {
    "User-Agent": USER_AGENT
}

os.makedirs(OUTPUT_FOLDER, exist_ok=True)


# =====================================================
# STEP 1: GET FILES FROM WIKIPEDIA CATEGORY
# =====================================================

def get_wikipedia_files():

    print(f"Fetching Wikipedia category: {WIKIPEDIA_CATEGORY}")

    files = []

    cmcontinue = None

    while True:

        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{WIKIPEDIA_CATEGORY}",
            "cmtype": "file",
            "cmlimit": "500",
            "format": "json"
        }

        if cmcontinue:
            params["cmcontinue"] = cmcontinue

        r = requests.get(WIKI_API, params=params, headers=headers)
        data = r.json()

        files.extend(data["query"]["categorymembers"])

        if "continue" in data:
            cmcontinue = data["continue"]["cmcontinue"]
        else:
            break

    print(f"Found {len(files)} files in Wikipedia category")

    return [file["title"] for file in files]


# =====================================================
# STEP 2: RESOLVE COMMONS PNG URL
# =====================================================

def get_image_url(file_title):

    params = {
        "action": "query",
        "titles": file_title,
        "prop": "imageinfo",
        "iiprop": "url|thumburl",
        "iiurlwidth": ICON_SIZE,
        "format": "json"
    }

    r = requests.get(WIKI_API, params=params, headers=headers)

    pages = r.json()["query"]["pages"]

    for page in pages.values():

        if "imageinfo" not in page:
            return None

        info = page["imageinfo"][0]

        if "thumburl" in info:
            return info["thumburl"]

        return info["url"]


# =====================================================
# STEP 3: CLEAN FILE NAME
# =====================================================

def clean_filename(filename):

    filename = filename.replace("File:", "")
    filename = filename.replace(" ", "_")
    filename = filename.replace("-", "_")

    return os.path.splitext(filename)[0] + ".png"


# =====================================================
# STEP 4: RESIZE AND CENTER
# =====================================================

def resize_and_center(img):

    width, height = img.size

    scale = min(ICON_SIZE / width, ICON_SIZE / height)

    new_width = int(width * scale)
    new_height = int(height * scale)

    img = img.resize((new_width, new_height), Image.LANCZOS)

    canvas = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))

    x = (ICON_SIZE - new_width) // 2
    y = (ICON_SIZE - new_height) // 2

    canvas.paste(img, (x, y), img)

    return canvas


# =====================================================
# STEP 5: DOWNLOAD AND PROCESS
# =====================================================

def download_and_process(file_title):

    filename = clean_filename(file_title)

    output_path = os.path.join(OUTPUT_FOLDER, filename)

    print(f"Downloading: {filename}")

    url = get_image_url(file_title)


    if not url:
        print("Skipping (no Commons file)")
        return

    r = requests.get(url, headers=headers)

    img = Image.open(io.BytesIO(r.content)).convert("RGBA")

    img = resize_and_center(img)

    img.save(output_path, "PNG")

    print(f"Saved: {output_path}")


# =====================================================
# MAIN PIPELINE
# =====================================================

def run():

    print("\n=== WIKIPEDIA → COMMONS ICON PIPELINE ===\n")

    files = get_wikipedia_files()

    for file in files:

        download_and_process(file)

    print("\n=== COMPLETE ===\n")


# =====================================================

if __name__ == "__main__":
    run()
