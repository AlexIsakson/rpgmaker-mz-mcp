/**
 * A cliff for a cave mouth to sit in.
 *
 * The RTP ships several "Entrance" objects — dark doorway silhouettes on the B
 * and C sheets, meant to be set into a rock face. Their edges are painted
 * transparent on purpose, expecting a cliff behind and beside them. Placed
 * alone on open ground the transparent edges show whatever is on the layers
 * below — grass, or nothing at all — so the dark shape reads as a hole
 * floating in a field rather than a cave mouth. The tile is correct; nothing
 * paints the rock it was drawn to sit against.
 *
 * **The hand-made corpus does not settle a single technique for that rock.**
 * Of the 293 sample maps, only 5 place a Cave or Mine Entrance object at all —
 * 10 placements in total — and no two use the same backing: one leans on A2
 * ground kinds alone, one paints raw A5 "Mountain" sheet tiles (not an
 * autotile family, so nothing generic can shape them the way A2/A4 can), one
 * builds a multi-layer A4 mountain mass unique to that map. Five maps using
 * three different approaches is too thin to call any of them "the"
 * convention, so this does not attempt to reproduce one of them.
 *
 * What it reuses instead is the wall top / wall face pairing this server
 * already trusts for a building or a room — one row of top capping the
 * silhouette, a band of face beneath it, `kind + 8` pairing the two by
 * default the way `interiorgen.ts` and `blueprint.ts` already do, itself
 * measured at 497 of 614 A3/A4 columns across the RTP (see CLAUDE.md). Sized
 * to backdrop the entrance rather than to match any one hand-drawn mountain,
 * this is a stated design rather than a measured one, and says so rather
 * than dressing a guess as a finding.
 *
 * This module is pure: it computes a small grid of wall cells, and never
 * touches a file.
 */

export type CliffCell = 'wallTop' | 'wallFace';

export interface CaveMouthOptions {
  /** Size of the entrance object itself — 1x1 for "Entrance A", 1x2 for "Cave Entrance". */
  entranceWidth: number;
  entranceHeight: number;
  /** Cliff either side of the entrance, in tiles. */
  margin?: number;
  /**
   * Rows of face above the entrance's own top edge, before the one row of
   * top that caps the whole thing — headroom so the entrance does not sit
   * flush against the cap. 1 by default.
   */
  headroom?: number;
}

export interface CaveMouthPlan {
  width: number;
  height: number;
  /** `cells[y][x]` over the footprint. */
  cells: CliffCell[][];
  /** Where the entrance's own top-left cell falls within the footprint. */
  entranceOffset: { x: number; y: number };
}

export class CaveMouthError extends Error {}

/**
 * Plan the cliff around an entrance object.
 *
 * One row of wall top caps the footprint; every row beneath it, for the full
 * width, is wall face — the entrance's own height plus `headroom` rows above
 * it. The entrance sits at `entranceOffset` within the footprint, on the
 * bottom rows, so the ground the player approaches from (the row below the
 * footprint) is left untouched.
 */
export function planCaveMouth(options: CaveMouthOptions): CaveMouthPlan {
  const { entranceWidth, entranceHeight } = options;
  const margin = options.margin ?? 1;
  const headroom = options.headroom ?? 1;

  if (entranceWidth < 1 || entranceHeight < 1) {
    throw new CaveMouthError(
      `The entrance is ${entranceWidth}x${entranceHeight} — both dimensions have to be at least 1.`
    );
  }
  if (margin < 0) throw new CaveMouthError('margin cannot be negative.');
  if (headroom < 0) throw new CaveMouthError('headroom cannot be negative.');

  const width = entranceWidth + margin * 2;
  const faceRows = entranceHeight + headroom;
  const height = faceRows + 1; // + the capping row of wall top

  const cells: CliffCell[][] = Array.from({ length: height }, (_, y) =>
    new Array<CliffCell>(width).fill(y === 0 ? 'wallTop' : 'wallFace')
  );

  return { width, height, cells, entranceOffset: { x: margin, y: height - entranceHeight } };
}
