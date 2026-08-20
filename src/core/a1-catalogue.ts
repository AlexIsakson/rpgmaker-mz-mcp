// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-a1-catalogue.mjs [tilesetsDir]
//
// Source: the `.txt` file RPG Maker MZ ships beside each tileset PNG. On the
// autotile sheets it holds one line per *kind* rather than per tile id, so an A1
// file is 16 lines. Projects do not ship those files, so the labels are baked in.
//
// These are names only. What the engine *does* with a kind comes from its slot —
// see describeA1Kind in water-autotile.ts — and the two disagree often enough to
// be worth reporting: of the 24 waterfall slots across these sheets,
// 10 carry a label that does not say "waterfall".

/** The editor's label for each of the 16 A1 kinds, indexed by kind. */
export const A1_SHEET_LABELS: Record<string, string[]> = {
  "Dungeon_A1": [
    "Water A",
    "Deep Water",
    "Swamp Grass",
    "Lotus Pads (Flowers)",
    "Lava",
    "Waterfall A (Lava Cave)",
    "Water B (Grass Maze)",
    "Waterfall B (Grass Maze)",
    "Water C (Dirt Cave)",
    "Waterfall C (Dirt Cave)",
    "Water D (Rock Cave)",
    "Waterfall D (Rock Cave)",
    "Water E (Crystal)",
    "Waterfall E (Crystal)",
    "Canal",
    "Waterfall (Stone Wall)",
  ],
  "Inside_A1": [
    "Water A",
    "Deep Water",
    "Lotus Pads (Flowers)",
    "Purple Water",
    "Water B (Surround Stonewall)",
    "Waterfall A (Shine Fall)",
    "Pond A (Rock Pond)",
    "Waterfall B (Grid Fall)",
    "Water C (Tile)",
    "Water D (Small Hole)",
    "Water E (Water Surface)",
    "Water F (Water Footing)",
    "Water G (Surround Waterwall)",
    "Water H (Big Hole)",
    "Pond B (Purple Rock Pond)",
    "Waterfall C (Purple Fall)",
  ],
  "Outside_A1": [
    "Water A (Meadow)",
    "Pond",
    "Swamp Grass A",
    "Swamp Grass B",
    "Water B (Snow)",
    "Waterfall A",
    "Canal",
    "Waterfall B (Stone Wall)",
    "Water C (Dirt)",
    "Waterfall C (Cliff)",
    "Water D (Sand)",
    "Waterfall D (Boulder)",
    "Water E (Port)",
    "Water Bubbles",
    "Poison Swamp",
    "Dead Tree",
  ],
  "World_A1": [
    "Sea",
    "Deep Sea",
    "Rock Shoal",
    "Icebergs",
    "Poison Swamp",
    "Dead Trees",
    "Lava",
    "Lava Bubbles",
    "Pond",
    "Boulder",
    "Frozen Sea",
    "Whirlpool",
    "Land's End",
    "Endless Waterfall",
    "Cloud (Land's End)",
    "Cloud",
  ],
};

/** The editor's name for a kind on a named A1 sheet, or null if it is not one we have. */
export function a1KindLabel(sheetName: string, kind: number): string | null {
  const labels = A1_SHEET_LABELS[sheetName];
  if (!labels || kind < 0 || kind >= labels.length) return null;
  return labels[kind];
}
