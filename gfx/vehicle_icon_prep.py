import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "gfx" / "vehicle_images" / "gran_turismo"
OUTPUT_DIR = ROOT / "gfx" / "vehicle_icons" / "gran_turismo_200_circle"
REPORT_PATH = ROOT / "gfx" / "vehicle_icons" / "gran_turismo_200_circle_report.json"

ICON_SIZE = 200
ICON_PADDING = 10
PNG_DPI = (96, 96)

MANUAL_REJECT_SUBSTRINGS = {
    "prototype",
}


def load_image_rgb(path: Path) -> Image.Image:
    with Image.open(path) as img:
        return img.convert("RGB")


def compute_quality_metrics(img: Image.Image) -> Dict[str, float]:
    probe = img.copy()
    probe.thumbnail((320, 320), Image.Resampling.BILINEAR)
    arr = np.asarray(probe).astype(np.float32)

    gray = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    gx = np.diff(gray, axis=1)
    gy = np.diff(gray, axis=0)

    sharpness = float(np.mean(np.abs(gx)) + np.mean(np.abs(gy)))
    grad = (np.pad(np.abs(gx), ((0, 0), (0, 1))) + np.pad(np.abs(gy), ((0, 1), (0, 0)))) / 2.0
    edge_density = float((grad > 12).mean())

    saturation = (np.max(arr, axis=2) - np.min(arr, axis=2)) / 255.0
    saturation_mean = float(saturation.mean())

    hist = np.histogram(gray, bins=128, range=(0, 255))[0].astype(np.float64)
    prob = hist / hist.sum()
    prob = prob[prob > 0]
    entropy = float(-(prob * np.log2(prob)).sum())

    score = float(sharpness + edge_density * 100.0 + saturation_mean * 30.0 + entropy)

    return {
        "width": float(img.width),
        "height": float(img.height),
        "sharpness": sharpness,
        "edge_density": edge_density,
        "saturation_mean": saturation_mean,
        "entropy": entropy,
        "score": score,
    }


def should_reject(filename: str, metrics: Dict[str, float]) -> Tuple[bool, str]:
    lower_name = filename.lower()
    if any(token in lower_name for token in MANUAL_REJECT_SUBSTRINGS):
        return True, "manual_reject_keyword"

    width = metrics["width"]
    height = metrics["height"]
    sharpness = metrics["sharpness"]
    edge_density = metrics["edge_density"]
    saturation_mean = metrics["saturation_mean"]
    entropy = metrics["entropy"]
    score = metrics["score"]

    if width < 500 or height < 320:
        return True, "small_source"
    if sharpness < 11.0 and edge_density < 0.14:
        return True, "low_detail"
    if saturation_mean < 0.09 and entropy < 6.0:
        return True, "washed_or_flat"
    if score < 33.0:
        return True, "low_quality_score"

    return False, "keep"


def dominant_border_colors(arr: np.ndarray, band: int) -> np.ndarray:
    h, w, _ = arr.shape
    band = max(2, min(band, h // 3, w // 3))
    border = np.concatenate(
        [
            arr[:band, :, :].reshape(-1, 3),
            arr[h - band :, :, :].reshape(-1, 3),
            arr[:, :band, :].reshape(-1, 3),
            arr[:, w - band :, :].reshape(-1, 3),
        ],
        axis=0,
    )

    quant = (border // 16).astype(np.int16)
    key = quant[:, 0] * 256 + quant[:, 1] * 16 + quant[:, 2]
    top_bins = [k for k, _ in Counter(key.tolist()).most_common(3)]
    colors: List[List[float]] = []
    for bin_key in top_bins:
        idx = key == bin_key
        if idx.any():
            colors.append(border[idx].mean(axis=0).tolist())
    if not colors:
        colors.append(border.mean(axis=0).tolist())
    return np.asarray(colors, dtype=np.float32)


def strip_background(img: Image.Image) -> Image.Image:
    arr = np.asarray(img).astype(np.float32)
    h, w, _ = arr.shape

    band = max(4, int(min(h, w) * 0.03))
    bg_colors = dominant_border_colors(arr, band)

    dist_stack = []
    for c in bg_colors:
        d = np.sqrt(np.sum((arr - c) ** 2, axis=2))
        dist_stack.append(d)
    dmin = np.min(np.stack(dist_stack, axis=2), axis=2)

    border = np.concatenate(
        [
            dmin[:band, :].reshape(-1),
            dmin[h - band :, :].reshape(-1),
            dmin[:, :band].reshape(-1),
            dmin[:, w - band :].reshape(-1),
        ]
    )
    threshold = float(np.percentile(border, 92) + 8.0)
    threshold = max(12.0, min(threshold, 48.0))

    bg_mask = dmin <= threshold

    alpha = np.where(bg_mask, 0, 255).astype(np.uint8)
    rgba = np.dstack([arr.astype(np.uint8), alpha])

    # Remove tiny opaque islands caused by JPEG artifacts.
    non_bg = np.argwhere(alpha > 0)
    if non_bg.size == 0:
        return Image.fromarray(rgba, mode="RGBA")

    y0, x0 = non_bg.min(axis=0)
    y1, x1 = non_bg.max(axis=0)
    cropped = rgba[y0 : y1 + 1, x0 : x1 + 1]

    return Image.fromarray(cropped, mode="RGBA")


def make_icon(img_rgba: Image.Image, size: int = ICON_SIZE, padding: int = ICON_PADDING) -> Image.Image:
    target = size - (padding * 2)
    w, h = img_rgba.size
    if w <= 0 or h <= 0:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))

    scale = min(target / w, target / h)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))

    fit = img_rgba.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ox = (size - nw) // 2
    oy = (size - nh) // 2
    canvas.alpha_composite(fit, (ox, oy))
    return canvas


def make_circle_icon(
    img_rgb: Image.Image,
    size: int = ICON_SIZE,
    padding: int = ICON_PADDING,
    circle_fill: float = 0.9,
) -> Image.Image:
    target = size - (padding * 2)
    w, h = img_rgb.size
    if w <= 0 or h <= 0:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # "Contain" fit to avoid clipping vehicle front/rear on wide source images.
    fill = max(0.5, min(circle_fill, 1.0))
    inner = max(1, int(round(target * fill)))
    scale = min(inner / w, inner / h)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    fit = img_rgb.resize((nw, nh), Image.Resampling.LANCZOS)
    tile = Image.new("RGBA", (target, target), (0, 0, 0, 0))
    ox_fit = (target - nw) // 2
    oy_fit = (target - nh) // 2
    tile.alpha_composite(fit.convert("RGBA"), (ox_fit, oy_fit))

    # Draw at higher resolution then downsample and feather slightly for smoother edges.
    aa = 8
    mask_large = Image.new("L", (target * aa, target * aa), 0)
    draw = ImageDraw.Draw(mask_large)
    draw.ellipse((0, 0, target * aa - 1, target * aa - 1), fill=255)
    mask = mask_large.resize((target, target), Image.Resampling.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=0.6))
    tile_alpha = np.asarray(tile.getchannel("A"), dtype=np.uint8)
    mask_arr = np.asarray(mask, dtype=np.uint8)
    combined = np.minimum(tile_alpha, mask_arr)
    tile.putalpha(Image.fromarray(combined, mode="L"))

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ox = (size - target) // 2
    oy = (size - target) // 2
    canvas.alpha_composite(tile, (ox, oy))
    return canvas


def process_image(path: Path, output_dir: Path, style: str, circle_fill: float) -> Dict[str, object]:
    src = load_image_rgb(path)
    metrics = compute_quality_metrics(src)
    reject, reason = should_reject(path.name, metrics)

    result: Dict[str, object] = {
        "file": path.name,
        "metrics": {k: round(v, 4) for k, v in metrics.items()},
        "rejected": reject,
        "reason": reason,
    }

    if reject:
        return result

    if style == "cutout":
        stripped = strip_background(src)
        icon = make_icon(stripped)
    else:
        icon = make_circle_icon(src, circle_fill=circle_fill)

    out_path = output_dir / (path.stem + ".png")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    icon.save(out_path, format="PNG", optimize=True, dpi=PNG_DPI)

    result["output"] = str(out_path.relative_to(ROOT)).replace("\\", "/")
    return result


def run(limit: int = 0, style: str = "circle", circle_fill: float = 0.9) -> None:
    source_dir = SOURCE_DIR
    output_dir = OUTPUT_DIR if style == "circle" else ROOT / "gfx" / "vehicle_icons" / "gran_turismo_200_cutout"
    report_path = REPORT_PATH if style == "circle" else ROOT / "gfx" / "vehicle_icons" / "gran_turismo_200_cutout_report.json"

    output_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(
        [
            p
            for p in source_dir.glob("*")
            if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ]
    )

    if limit > 0:
        images = images[:limit]

    results: List[Dict[str, object]] = []
    kept = 0
    rejected = 0

    total = len(images)
    for idx, path in enumerate(images, start=1):
        item = process_image(path, output_dir, style=style, circle_fill=circle_fill)
        results.append(item)
        if item["rejected"]:
            rejected += 1
        else:
            kept += 1

        if idx % 50 == 0 or idx == total:
            print(f"[{idx}/{total}] kept={kept} rejected={rejected}")

    report = {
        "source_dir": str(source_dir),
        "output_dir": str(output_dir),
        "icon_size": ICON_SIZE,
        "dpi": PNG_DPI,
        "style": style,
        "circle_fill": circle_fill,
        "total": total,
        "kept": kept,
        "rejected": rejected,
        "results": results,
    }

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("Done")
    print(f"Output icons: {output_dir}")
    print(f"Report: {report_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build map-ready vehicle icons from Gran Turismo source images.")
    parser.add_argument("--limit", type=int, default=0, help="Process only the first N images (for quick tests).")
    parser.add_argument("--style", choices=["circle", "cutout"], default="circle", help="Icon style.")
    parser.add_argument(
        "--circle-fill",
        type=float,
        default=0.9,
        help="For circle style: proportion of the circle used by the image (0.5-1.0).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run(limit=args.limit, style=args.style, circle_fill=args.circle_fill)
