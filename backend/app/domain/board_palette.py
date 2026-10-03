"""domain/board_palette — the editor's draw palette as the AI's DEFAULT style.

AI-drawn boards (text→diagram, sketch→board and the chat co-editor) wear the
SAME palette the style panel offers, so an AI board looks like one the user
drew by hand. The prompt asks for it, and ``enforce()`` guarantees it on what
the AI produced (existing user objects are never recoloured).

MIRRORED in ``web/src/editor-core/diagram/palette.ts`` (the style panel reads
it) — ``tests/test_board_palette.py`` fails on any drift between the two.
"""

from __future__ import annotations


INK = "#2d3142"

# Stroke row of the style panel (also text / arrow / pen colours).
STROKES: tuple[str, ...] = ("#2d3142", "#dc2626", "#16a34a", "#2563eb", "#eb6c36")

# Background row ("transparent" first).
FILLS: tuple[str, ...] = ("transparent", "#ffffff", "#fee2e2", "#dcfce7", "#dbeafe", "#fef9c3")

# One-click style pairs: stroke + its matching pastel fill.
STYLE_PAIRS: tuple[tuple[str, str, str], ...] = (
    ("Ink", "#2d3142", "#ffffff"),
    ("Red", "#dc2626", "#fee2e2"),
    ("Green", "#16a34a", "#dcfce7"),
    ("Blue", "#2563eb", "#dbeafe"),
    ("Ember", "#eb6c36", "#fef9c3"),
)

PALETTES = ("board",)
DEFAULT_PALETTE = "board"


def resolve_palette(value: object) -> str:
    """Map a request value to a known palette; junk/empty ⇒ the default."""
    v = str(value or "").strip().lower()
    return v if v in PALETTES else DEFAULT_PALETTE


def prompt_section() -> str:
    """Prompt text for the board palette — GENERATED from the tables above.

    Appended to the AI prompts; only the COLOURS and the hand-drawn finish."""
    pairs = "\n".join(f'  {n}: stroke "{s}", fill "{f}"' for n, s, f in STYLE_PAIRS)
    strokes = ", ".join(f'"{c}"' for c in STROKES)
    fills = ", ".join(f'"{c}"' for c in FILLS)
    return (
        "\n### COLOURS — the board palette (takes precedence over any other "
        "colour guidance)\n"
        "Paint with the editor's draw palette ONLY — the same swatches the user "
        "picks from, so your board looks hand-made in noddle:\n"
        f"- strokes / text / arrows: {strokes} (ink {INK} is the default for "
        "text, arrows and neutral shapes)\n"
        f"- fills: {fills}\n"
        "- style pairs (use these stroke+fill combos for coloured shapes):\n"
        f"{pairs}\n"
        "- Colour by MEANING, consistently: one pair per group / layer / lane "
        "(e.g. sources blue, processing green, quality gates ember, failures "
        "and rollback red, neutral steps ink); containers / lanes use the pastel "
        "fill of their group with the matching stroke.\n"
        f'- Hand-drawn finish (overrides any "sketch only when asked" rule above): "sketch": true and "cornerRadius": 12 on boxes; '
        f'strokeWidth 2; edge stroke {INK} unless the edge belongs to a coloured '
        "group.\n"
        f'- ALL text (titles, labels, captions, sublabels) is ink "{INK}" — or the '
        "stroke colour of its pair for a coloured tag. No greys or other blues.\n"
        "- Never invent other hexes; never use translucent rgba fills.\n"
    )


# ---- deterministic enforcement (the prompt alone is not enough) -----------
# Models drift toward their own greys / mono labels / no sketch. After a generation — or for the
# objects an edit ADDED — every colour is snapped to the nearest family of this
# palette and the hand-drawn finish is applied. Existing user objects are
# never touched.

_FAMILY = {  # family -> (stroke, pastel fill)
    "ink": ("#2d3142", "#ffffff"),
    "red": ("#dc2626", "#fee2e2"),
    "green": ("#16a34a", "#dcfce7"),
    "blue": ("#2563eb", "#dbeafe"),
    "ember": ("#eb6c36", "#fef9c3"),
}
_PALETTE_SET = {c.lower() for c in (*STROKES, *FILLS)}


def _hex_rgb(v: str) -> tuple[float, float, float] | None:
    v = v.strip().lower()
    if len(v) == 4 and v.startswith("#"):
        v = "#" + "".join(ch * 2 for ch in v[1:])
    if len(v) != 7 or not v.startswith("#"):
        return None
    try:
        return tuple(int(v[i:i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]
    except ValueError:
        return None


def _family(rgb: tuple[float, float, float]) -> tuple[str, float, float]:
    """(family, saturation, lightness) by HSL hue buckets."""
    import colorsys

    h, l, s = colorsys.rgb_to_hls(*rgb)
    if s < 0.18 or l > 0.97 or l < 0.06:
        return "ink", s, l
    deg = h * 360
    if deg < 15 or deg >= 330:
        fam = "red"
    elif deg < 65:
        fam = "ember"
    elif deg < 170:
        fam = "green"
    elif deg < 290:
        fam = "blue"
    else:
        fam = "red"
    return fam, s, l


def snap_color(value: object, role: str) -> str | None:
    """Map any colour to the board palette. ``role``: stroke | fill | text.
    Returns None when the value isn't a parseable colour (caller keeps it)."""
    v = str(value or "").strip().lower()
    if not v:
        return None
    if v in ("transparent", "none"):
        return "transparent" if role == "fill" else None
    if v in _PALETTE_SET:
        if role == "text" and v not in {c.lower() for c in STROKES}:
            return INK  # a pastel used as text is unreadable
        return v
    rgb = _hex_rgb(v)
    if rgb is None:
        return None
    fam, sat, l = _family(rgb)
    if role in ("stroke", "text") and sat < 0.35:
        fam = "ink"  # slate / blue-grey lines and text read as ink
    stroke, pastel = _FAMILY[fam]
    if role == "fill":
        if fam == "ink":
            return "#ffffff" if l > 0.6 else "transparent"
        return pastel
    return stroke  # stroke / text: the strong colour of the family


def enforce(nodes: list[dict], edges: list[dict], only_ids: set[str] | None = None) -> int:
    """Snap colours + apply the hand-drawn finish in place. ``only_ids`` limits
    it to those objects (an edit's additions). Returns the number of objects
    changed. Never raises on odd input."""
    changed = 0
    for n in nodes:
        if not isinstance(n, dict) or (only_ids is not None and str(n.get("id")) not in only_ids):
            continue
        if n.get("kind") in ("image", "icon", "freedraw"):
            continue  # pictures / ink keep their own look
        before = dict(n)
        for key, role in (("fill", "fill"), ("stroke", "stroke"), ("textColor", "text")):
            if key in n:
                snapped = snap_color(n.get(key), role)
                if snapped is not None:
                    n[key] = snapped
        if n.get("fontFamily") in ("mono", "serif"):
            n.pop("fontFamily", None)  # the handwriting/sans house face
        if n.get("kind") not in ("text", "line"):
            n["sketch"] = True
            if n.get("kind") in ("rect", "rounded", "process", None) and not n.get("cornerRadius"):
                n["cornerRadius"] = 12
        if n != before:
            changed += 1
    for e in edges:
        if not isinstance(e, dict) or (only_ids is not None and str(e.get("id")) not in only_ids):
            continue
        before = dict(e)
        snapped = snap_color(e.get("stroke"), "stroke")
        if snapped is not None:
            e["stroke"] = snapped
        if e != before:
            changed += 1
    return changed
