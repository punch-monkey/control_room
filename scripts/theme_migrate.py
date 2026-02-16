"""
Migrate hardcoded colours in style.css to CSS custom properties,
expand the variable set, and add 4 switchable theme palettes.
"""
import re, sys

CSS_PATH = r"c:\Users\44752\Desktop\Control Room\css\style.css"

with open(CSS_PATH, "r", encoding="utf-8") as f:
    css = f.read()

# ── Step 1: Replace the existing :root block with expanded variables ──
# The new :root will be the Midnight Indigo defaults
old_root_pattern = r":root\s*\{[^}]+\}"
new_root = """:root {
  /* ── Layout ── */
  --ui-radius: 10px;
  --ui-radius-sm: 6px;
  --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-smooth: 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  /* ── Backgrounds ── */
  --ui-bg-body: #0a0e1a;
  --ui-bg: rgba(10, 14, 26, 0.96);
  --ui-bg-solid: #0a0e1a;
  --ui-surface: rgba(16, 22, 40, 0.88);
  --ui-card-bg: rgba(255, 255, 255, 0.025);
  --ui-input-bg: rgba(255, 255, 255, 0.04);
  --ui-popup-bg: rgba(10, 14, 26, 0.97);

  /* ── Borders ── */
  --ui-border: rgba(99, 102, 241, 0.18);
  --ui-border-subtle: rgba(255, 255, 255, 0.06);
  --ui-card-border: rgba(255, 255, 255, 0.05);
  --ui-input-border: rgba(180, 190, 220, 0.18);
  --ui-popup-border: rgba(99, 102, 241, 0.15);
  --ui-accent-border: rgba(99, 102, 241, 0.3);

  /* ── Text ── */
  --ui-text: #e0e7ff;
  --ui-text-bright: #f1f5f9;
  --ui-subtle: #8b95b0;
  --ui-text-muted: #5b6380;

  /* ── Primary accent (indigo) ── */
  --ui-accent: #818cf8;
  --ui-accent-strong: #6366f1;
  --ui-accent-glow: rgba(99, 102, 241, 0.35);
  --ui-accent-soft: rgba(99, 102, 241, 0.1);

  /* ── Secondary accent (blue) ── */
  --ui-secondary: #60a5fa;
  --ui-secondary-soft: rgba(96, 165, 250, 0.1);

  /* ── Buttons ── */
  --ui-btn-primary-from: #4f46e5;
  --ui-btn-primary-to: #6366f1;

  /* ── Status ── */
  --ui-alert: #ef4444;
  --ui-ok: #22c55e;
  --ui-gold: #fbbf24;
}"""

css = re.sub(old_root_pattern, new_root, css, count=1)

# ── Step 2: Add theme palette overrides right after :root ──
theme_blocks = """

/* ══ Theme: Warm Intelligence ══ */
[data-theme="warm"] {
  --ui-bg-body: #0d0c0a;
  --ui-bg: rgba(13, 12, 10, 0.96);
  --ui-bg-solid: #0d0c0a;
  --ui-surface: rgba(24, 22, 18, 0.88);
  --ui-card-bg: rgba(255, 255, 255, 0.025);
  --ui-input-bg: rgba(255, 255, 255, 0.04);
  --ui-popup-bg: rgba(13, 12, 10, 0.97);
  --ui-border: rgba(245, 158, 11, 0.18);
  --ui-border-subtle: rgba(255, 255, 255, 0.06);
  --ui-card-border: rgba(255, 255, 255, 0.05);
  --ui-input-border: rgba(200, 180, 140, 0.18);
  --ui-popup-border: rgba(245, 158, 11, 0.15);
  --ui-accent-border: rgba(245, 158, 11, 0.3);
  --ui-text: #f5e6d0;
  --ui-text-bright: #fef3c7;
  --ui-subtle: #a09080;
  --ui-text-muted: #6b5e50;
  --ui-accent: #fbbf24;
  --ui-accent-strong: #f59e0b;
  --ui-accent-glow: rgba(245, 158, 11, 0.35);
  --ui-accent-soft: rgba(245, 158, 11, 0.1);
  --ui-secondary: #f97316;
  --ui-secondary-soft: rgba(249, 115, 22, 0.1);
  --ui-btn-primary-from: #b45309;
  --ui-btn-primary-to: #d97706;
}

/* ══ Theme: Arctic Command ══ */
[data-theme="arctic"] {
  --ui-bg-body: #060d14;
  --ui-bg: rgba(6, 13, 20, 0.96);
  --ui-bg-solid: #060d14;
  --ui-surface: rgba(12, 24, 38, 0.88);
  --ui-card-bg: rgba(255, 255, 255, 0.025);
  --ui-input-bg: rgba(255, 255, 255, 0.04);
  --ui-popup-bg: rgba(6, 13, 20, 0.97);
  --ui-border: rgba(125, 211, 252, 0.18);
  --ui-border-subtle: rgba(255, 255, 255, 0.06);
  --ui-card-border: rgba(255, 255, 255, 0.05);
  --ui-input-border: rgba(140, 200, 240, 0.18);
  --ui-popup-border: rgba(125, 211, 252, 0.15);
  --ui-accent-border: rgba(125, 211, 252, 0.3);
  --ui-text: #e0f2fe;
  --ui-text-bright: #f0f9ff;
  --ui-subtle: #7da5c0;
  --ui-text-muted: #4b7590;
  --ui-accent: #7dd3fc;
  --ui-accent-strong: #38bdf8;
  --ui-accent-glow: rgba(125, 211, 252, 0.35);
  --ui-accent-soft: rgba(125, 211, 252, 0.1);
  --ui-secondary: #a5b4fc;
  --ui-secondary-soft: rgba(165, 180, 252, 0.1);
  --ui-btn-primary-from: #0284c7;
  --ui-btn-primary-to: #0ea5e9;
}

/* ══ Theme: Teal Operations ══ */
[data-theme="teal"] {
  --ui-bg-body: #04080d;
  --ui-bg: rgba(6, 12, 20, 0.95);
  --ui-bg-solid: #060c14;
  --ui-surface: rgba(12, 22, 35, 0.88);
  --ui-card-bg: rgba(255, 255, 255, 0.02);
  --ui-input-bg: rgba(255, 255, 255, 0.04);
  --ui-popup-bg: rgba(8, 12, 20, 0.97);
  --ui-border: rgba(45, 212, 191, 0.18);
  --ui-border-subtle: rgba(255, 255, 255, 0.05);
  --ui-card-border: rgba(255, 255, 255, 0.035);
  --ui-input-border: rgba(180, 214, 238, 0.18);
  --ui-popup-border: rgba(45, 212, 191, 0.12);
  --ui-accent-border: rgba(45, 212, 191, 0.3);
  --ui-text: #d6e3ef;
  --ui-text-bright: #f1f5f9;
  --ui-subtle: #7e95a8;
  --ui-text-muted: #64748b;
  --ui-accent: #2dd4bf;
  --ui-accent-strong: #06b6d4;
  --ui-accent-glow: rgba(45, 212, 191, 0.35);
  --ui-accent-soft: rgba(45, 212, 191, 0.1);
  --ui-secondary: #818cf8;
  --ui-secondary-soft: rgba(99, 102, 241, 0.1);
  --ui-btn-primary-from: #0891b2;
  --ui-btn-primary-to: #0d9488;
}
"""

# Insert theme blocks right after the :root closing brace
root_end = css.find("}", css.find(":root {")) + 1
css = css[:root_end] + theme_blocks + css[root_end:]

# ── Step 3: Bulk replacements — migrate hardcoded colours to variables ──
# Order matters: more specific patterns first

replacements = [
    # Body background
    (r"background:\s*#04080d", "background: var(--ui-bg-body)"),

    # Panel / popup backgrounds (specific rgba patterns → variables)
    (r"background:\s*rgba\(6,\s*12,\s*20,\s*0\.95\)", "background: var(--ui-bg)"),
    (r"background:\s*rgba\(8,\s*12,\s*20,\s*0\.97\)", "background: var(--ui-popup-bg)"),
    (r"background:\s*rgba\(7,\s*16,\s*23,\s*0\.9[5-8]\)", "background: var(--ui-popup-bg)"),
    (r"background:\s*rgba\(10,\s*12,\s*18,\s*0\.9[5-6]\)", "background: var(--ui-popup-bg)"),
    (r"background:\s*rgba\(12,\s*22,\s*35,\s*0\.88\)", "background: var(--ui-surface)"),
    (r"background:\s*rgba\(10,\s*16,\s*28,\s*0\.96\)", "background: var(--ui-popup-bg)"),

    # Card backgrounds
    (r"background:\s*rgba\(255,\s*255,\s*255,\s*0\.02\b\)", "background: var(--ui-card-bg)"),
    (r"background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\b\)", "background: var(--ui-card-bg)"),

    # Input backgrounds
    (r"background:\s*rgba\(255,\s*255,\s*255,\s*0\.04\b\)", "background: var(--ui-input-bg)"),

    # Primary button gradient
    (r"background:\s*linear-gradient\(135deg,\s*#0891b2\s+0%,\s*#0d9488\s+100%\)",
     "background: linear-gradient(135deg, var(--ui-btn-primary-from) 0%, var(--ui-btn-primary-to) 100%)"),

    # Teal accent borders → variable (covering common rgba(45,212,191,...) patterns)
    (r"border(?:-color)?:\s*1px\s+solid\s+rgba\(45,\s*212,\s*191,\s*0\.1\b\)", "border: 1px solid var(--ui-border)"),
    (r"border:\s*1px\s+solid\s+rgba\(45,\s*212,\s*191,\s*0\.18\)", "border: 1px solid var(--ui-border)"),
    (r"border:\s*1px\s+solid\s+rgba\(45,\s*212,\s*191,\s*0\.22\)", "border: 1px solid var(--ui-border)"),
    (r"border:\s*1px\s+solid\s+rgba\(45,\s*212,\s*191,\s*0\.28\)", "border: 1px solid var(--ui-accent-border)"),
    (r"border-color:\s*rgba\(45,\s*212,\s*191,\s*0\.4[02]\)", "border-color: var(--ui-accent-border)"),

    # White borders → variable
    (r"border:\s*1px\s+solid\s+rgba\(255,\s*255,\s*255,\s*0\.0[56]\)", "border: 1px solid var(--ui-border-subtle)"),
    (r"border-bottom:\s*1px\s+solid\s+rgba\(255,\s*255,\s*255,\s*0\.0[56]\)", "border-bottom: 1px solid var(--ui-border-subtle)"),

    # Indigo borders → variable
    (r"border:\s*1px\s+solid\s+rgba\(99,\s*102,\s*241,\s*0\.1[058]\)", "border: 1px solid var(--ui-border)"),
    (r"border:\s*1px\s+solid\s+rgba\(99,\s*102,\s*241,\s*0\.2\b\)", "border: 1px solid var(--ui-accent-border)"),
    (r"border:\s*1px\s+solid\s+rgba\(99,\s*102,\s*241,\s*0\.15\)", "border: 1px solid var(--ui-popup-border)"),

    # Popup-specific borders
    (r"border:\s*1px\s+solid\s+rgba\(45,\s*212,\s*191,\s*0\.12\)", "border: 1px solid var(--ui-popup-border)"),

    # Title gradient (accent-based shimmer)
    (r"background:\s*linear-gradient\(135deg,\s*#06b6d4,\s*#2dd4bf,\s*#06b6d4\)",
     "background: linear-gradient(135deg, var(--ui-accent-strong), var(--ui-accent), var(--ui-accent-strong))"),

    # Text colour replacements
    (r"(?<!-)color:\s*#d6e3ef", "color: var(--ui-text)"),
    (r"(?<!-)color:\s*#f1f5f9", "color: var(--ui-text-bright)"),
    (r"(?<!-)color:\s*#94a3b8", "color: var(--ui-subtle)"),
    (r"(?<!-)color:\s*#7e95a8", "color: var(--ui-subtle)"),
    (r"(?<!-)color:\s*#64748b(?!;?\s*/)", "color: var(--ui-text-muted)"),
    (r"(?<!-)color:\s*#cbd5e1", "color: var(--ui-text)"),

    # Accent text colours
    (r"(?<!-)color:\s*#2dd4bf", "color: var(--ui-accent)"),
    (r"(?<!-)color:\s*#67e8f9", "color: var(--ui-accent)"),
    (r"(?<!-)color:\s*#06b6d4", "color: var(--ui-accent-strong)"),
    (r"(?<!-)color:\s*#5eead4", "color: var(--ui-accent)"),
    (r"(?<!-)color:\s*#bffaf1", "color: var(--ui-accent)"),
    (r"(?<!-)color:\s*#a7f3d0", "color: var(--ui-accent)"),

    # Secondary accent text (indigo/purple)
    (r"(?<!-)color:\s*#818cf8", "color: var(--ui-secondary)"),
    (r"(?<!-)color:\s*#a78bfa", "color: var(--ui-secondary)"),

    # Accent backgrounds (teal-tinted)
    (r"background:\s*rgba\(45,\s*212,\s*191,\s*0\.0[4-8]\)", "background: var(--ui-accent-soft)"),
    (r"background:\s*rgba\(45,\s*212,\s*191,\s*0\.1[0-5]\)", "background: var(--ui-accent-soft)"),
    (r"background:\s*rgba\(45,\s*212,\s*191,\s*0\.14\)", "background: var(--ui-accent-soft)"),

    # Indigo backgrounds
    (r"background:\s*rgba\(99,\s*102,\s*241,\s*0\.0[4-8]\)", "background: var(--ui-accent-soft)"),
    (r"background:\s*rgba\(99,\s*102,\s*241,\s*0\.1[0-2]\)", "background: var(--ui-accent-soft)"),

    # Tab active states (cyan/teal → accent)
    (r"(?<!-)color:\s*#22d3ee", "color: var(--ui-accent)"),
    (r"border-bottom-color:\s*#22d3ee", "border-bottom-color: var(--ui-accent-strong)"),
    (r"background:\s*rgba\(34,\s*211,\s*238,\s*0\.09\)", "background: var(--ui-accent-soft)"),

    # Dropdown menu background
    (r"background:\s*rgba\(7,\s*16,\s*23,\s*0\.98\)", "background: var(--ui-popup-bg)"),

    # Scrollbar
    (r"background:\s*rgba\(45,\s*212,\s*191,\s*0\.12\)", "background: var(--ui-accent-soft)"),
    (r"background:\s*rgba\(45,\s*212,\s*191,\s*0\.24\)", "background: var(--ui-accent-soft)"),
]

for pattern, replacement in replacements:
    css = re.sub(pattern, replacement, css)

# ── Step 4: Write it back ──
with open(CSS_PATH, "w", encoding="utf-8") as f:
    f.write(css)

print("Theme migration complete.")
print(f"File size: {len(css)} bytes")
