#!/usr/bin/env python3
"""
One-shot migration: rewrites seattle_band_members-2-2.csv so the single `scene`
column is replaced by three columns `city`, `state`, `country`.

Rules (USPS-style):
- city:    plain text, title case, no abbreviation
- state:   USPS 2-letter uppercase code for US locations only; blank otherwise
- country: ISO 3-letter code (USA, NZL, GBR, AUS, ...)

Typo fixes applied during migration:
- Issaqua  -> Issaquah
- Aukland  -> Auckland

The script does two things:
1. Prints an anomaly report of every unique scene value it can't confidently map.
2. If --write is passed, rewrites the CSV in place using the confirmed mapping.

Anomalies are surfaced but NOT auto-decided. This lets the human review before
committing.
"""
import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

CSV_PATH = Path(__file__).parent.parent / "seattle_band_members-2-2.csv"

# Canonical mapping: current scene value -> (city, state, country)
# Populated below; anything not in this map is treated as an anomaly.
SCENE_MAP: dict[str, tuple[str, str, str]] = {
    # US, well-formed
    "Seattle, WA":        ("Seattle",        "WA", "USA"),
    "Tacoma, WA":         ("Tacoma",         "WA", "USA"),
    "Portland, OR":       ("Portland",       "OR", "USA"),
    "New York, NY":       ("New York",       "NY", "USA"),
    "Chicago, IL":        ("Chicago",        "IL", "USA"),
    "Cleveland, OH":      ("Cleveland",      "OH", "USA"),
    "Coral Springs, FL":  ("Coral Springs",  "FL", "USA"),
    "Champaign, IL":      ("Champaign",      "IL", "USA"),
    "Kansas City, MO":    ("Kansas City",    "MO", "USA"),
    "Oklahoma City, OK":  ("Oklahoma City",  "OK", "USA"),
    "Palm Desert, CA":    ("Palm Desert",    "CA", "USA"),
    "Rockford, IL":       ("Rockford",       "IL", "USA"),
    "Venice, CA":         ("Venice",         "CA", "USA"),

    # US, needs typo fix or state inference
    "Issaqua, WA":        ("Issaquah",       "WA", "USA"),  # typo fix
    "Los Angeles":        ("Los Angeles",    "CA", "USA"),  # inferred state
    "New Jersey":         ("Berkeley Heights", "NJ", "USA"),  # per user: Neverland is from Berkeley Heights, NJ

    # Non-US
    "Aukland, NZ":        ("Auckland",       "",   "NZL"),  # typo fix
    "Sydney, AU":         ("Sydney",         "",   "AUS"),
    "Melbourne, AU":      ("Melbourne",      "",   "AUS"),
    "London, EN":         ("London",         "",   "GBR"),
    "Birmingham, EN":     ("Birmingham",     "",   "GBR"),
    "Manchester, EN":     ("Manchester",     "",   "GBR"),
    "Glasgow, SCT":       ("Glasgow",        "",   "GBR"),
}

# Explicit anomalies we already know we need the human to decide on.
# Every other scene value is auto-classified by presence in SCENE_MAP.
ALWAYS_ANOMALIES: set[str] = set()


def load_rows():
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        rows = list(reader)
    return rows[0], rows[1:]


def classify():
    """Return (header, rows, scene_counts, anomaly_rows).

    An anomaly row is one whose `scene` value is not in SCENE_MAP (or is in
    ALWAYS_ANOMALIES). Anomalies need human resolution before we can migrate.
    """
    header, rows = load_rows()

    # Find scene column index
    try:
        scene_idx = header.index("scene")
    except ValueError:
        raise SystemExit(f"CSV header has no 'scene' column. Header: {header}")

    scene_counts: Counter[str] = Counter()
    anomalies: dict[str, list[list[str]]] = defaultdict(list)

    for row in rows:
        if len(row) <= scene_idx:
            continue
        scene = row[scene_idx].strip()
        scene_counts[scene] += 1
        if scene not in SCENE_MAP or scene in ALWAYS_ANOMALIES:
            anomalies[scene].append(row)

    return header, rows, scene_idx, scene_counts, anomalies


def report():
    header, rows, scene_idx, scene_counts, anomalies = classify()

    total_rows = len(rows)
    mapped = sum(count for s, count in scene_counts.items()
                 if s in SCENE_MAP and s not in ALWAYS_ANOMALIES)
    anomaly_row_count = sum(len(v) for v in anomalies.values())

    print("=" * 72)
    print(f"CSV: {CSV_PATH.name}")
    print(f"Total data rows: {total_rows}")
    print(f"Auto-mappable rows: {mapped}")
    print(f"Anomaly rows needing human decision: {anomaly_row_count}")
    print("=" * 72)
    print()
    print("KNOWN MAPPINGS (will auto-apply):")
    print()
    print(f"  {'Current scene':<22}  ->  {'city':<16} {'state':<6} {'country':<8} (rows)")
    print(f"  {'-'*22}      {'-'*16} {'-'*6} {'-'*8}  -----")
    for scene, (city, state, country) in sorted(SCENE_MAP.items()):
        if scene in ALWAYS_ANOMALIES:
            continue
        count = scene_counts.get(scene, 0)
        marker = ""
        if scene == "Issaqua, WA":
            marker = "  [TYPO FIX]"
        if scene == "Aukland, NZ":
            marker = "  [TYPO FIX]"
        if scene == "Los Angeles":
            marker = "  [inferred state: CA]"
        print(f"  {scene:<22}  ->  {city:<16} {state:<6} {country:<8} ({count}){marker}")

    print()
    print("=" * 72)
    print("ANOMALIES — need your decision before migrating:")
    print("=" * 72)
    print()

    for scene in sorted(anomalies.keys()):
        rows_for_scene = anomalies[scene]
        print(f"Scene value: {scene!r}")
        print(f"  Rows affected: {len(rows_for_scene)}")
        print(f"  Sample rows (up to 10):")
        for r in rows_for_scene[:10]:
            # source, target (columns 0, 1)
            source = r[0] if len(r) > 0 else ""
            target = r[1] if len(r) > 1 else ""
            print(f"    band={source!r:35}  member={target!r}")
        if len(rows_for_scene) > 10:
            print(f"    ...and {len(rows_for_scene) - 10} more")
        print()


def apply_migration(mapping_overrides: dict[str, tuple[str, str, str]] | None = None):
    """Rewrite CSV in place with new columns.

    mapping_overrides: additional or replacement mappings for anomaly scenes.
    """
    header, rows, scene_idx, _, anomalies = classify()

    # Merge base map with any overrides
    full_map = dict(SCENE_MAP)
    if mapping_overrides:
        full_map.update(mapping_overrides)

    # Verify every anomaly is now resolved
    unresolved = [s for s in anomalies if s not in full_map or s in ALWAYS_ANOMALIES and s not in (mapping_overrides or {})]
    if unresolved:
        print("REFUSING TO MIGRATE — unresolved anomalies:", file=sys.stderr)
        for s in unresolved:
            print(f"  {s!r}", file=sys.stderr)
        sys.exit(2)

    # Build new header
    new_header = list(header)
    new_header[scene_idx:scene_idx+1] = ["city", "state", "country"]

    # Build new rows
    new_rows = []
    for row in rows:
        if len(row) <= scene_idx:
            # short row: keep as-is but pad
            new_rows.append(row + ["", "", ""])
            continue
        scene = row[scene_idx].strip()
        city, state, country = full_map.get(scene, ("", "", ""))
        new_row = list(row)
        new_row[scene_idx:scene_idx+1] = [city, state, country]
        new_rows.append(new_row)

    # Write in place
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(new_header)
        writer.writerows(new_rows)

    print(f"Migrated {len(new_rows)} rows.")
    print(f"New header: {new_header}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--write":
        # Overrides can be passed via a Python-parsed second arg, e.g.
        #   ./migrate_scene.py --write '{"Alex ": ["Seattle", "WA", "USA"]}'
        overrides = {}
        if len(sys.argv) > 2:
            import ast
            raw = ast.literal_eval(sys.argv[2])
            overrides = {k: tuple(v) for k, v in raw.items()}
        apply_migration(overrides)
    else:
        report()
