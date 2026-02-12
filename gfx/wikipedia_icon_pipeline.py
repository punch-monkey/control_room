import requests
import os
import io
from PIL import Image

# ==============================
# USER SETTINGS
# ==============================

CATEGORY = "Logos_of_airports_in_the_United_Kingdom"

OUTPUT_FOLDER = r"C:\Users\44752\Desktop\Control Room\GFX\airport_icons"

ICON_SIZE = 200

USER_AGENT = "ControlRoomIconPipeline/1.0"

# ==============================

API_URL = "https://commons.wikimedia.org/w/api.php"

headers = {
    "User-Agent": USER_AGENT
}

os.makedirs(OUTPUT_FOLDER, exist_ok=True)


def get_category_files():

    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": f"Category:{CATEGORY}",
        "cmtype": "file",
        "cmlimit": "500",
        "format": "json"
    }

    r = requests.get(API_URL, params=params, headers=headers)

    return [item["title"] for item in r.json()["query"]["categorymembers"]]


def get_png_url(file_title):

    params = {
        "action": "query",
        "titles": file_title,
        "prop": "imageinfo",
        "iiprop": f"url|thumburl",
        "iiurlwidth": ICON_SIZE,
        "format": "json"
    }

    r = requests.get(API_URL, params=params, headers=headers)

    pages = r.json()["query"]["pages"]

    for page in pages.values():
        info = page["imageinfo"][0]

        if "thumburl" in info:
            return info["thumburl"]

        return info["url"]


def clean_filename(filename):

    filename = filename.replace("File:", "")
    filename = filename.replace(" ", "_")
    filename = filename.replace("-", "_")

    return os.path.splitext(filename)[0] + ".png"


def download_and_process(file_title):

    filename = clean_filename(file_title)

    output_path = os.path.join(OUTPUT_FOLDER, filename)

    print(f"Downloading: {filename}")

    url = get_png_url(file_title)

    r = requests.get(url, headers=headers)

    img = Image.open(io.BytesIO(r.content)).convert("RGBA")

    img = resize_and_center(img)

    img.save(output_path, "PNG")

    print(f"Saved: {output_path}")


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


def run():

    print("\n=== Wikimedia Icon Pipeline ===\n")

    files = get_category_files()

    print(f"Found {len(files)} files\n")

    for file in files:
        download_and_process(file)

    print("\n=== COMPLETE ===\n")


if __name__ == "__main__":
    run()
