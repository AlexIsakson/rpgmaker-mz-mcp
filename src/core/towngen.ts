import { makeRng } from './mapgen.js';
import { raggedRect, longestBoundaryRun, RAGGED_DEFAULTS } from './ragged.js';
import type { Rect } from './autotile.js';
import type { DoorSide } from './blueprint.js';

/**
 * Town layout.
 *
 * This plans and nothing else: it decides where the roads, the buildings, the
 * doors and the decoration go, and hands back a description. Turning that into
 * tiles is the tool's job, and it does it with the primitives that already
 * exist — `fill_map_region` for ground and roads, `placeBuildingOnMap` for each
 * house, `place_prop` for the props. Keeping the two apart is what makes the
 * layout testable: every property below is asserted against the plan, with no
 * map file involved.
 *
 * **The layout used to be built around a constraint of the building primitive.**
 * A door sat on the bottom wall row and was approached from the tile below it,
 * so a building only worked with a road immediately beneath it. The town read as
 * horizontal bands, each one a row of buildings sitting on the street it faces —
 * and the top of every band, against the road above, was dead ground:
 *
 *     ~~~~~~~~~~~~~~~~   frame
 *     ###  ###   ####    band  — buildings, bottom-aligned
 *     ================   road  — full width, so it reaches both map edges
 *     ....dead ground...
 *     ####  ###  ###     band
 *     ================   road
 *     ~~~~~~~~~~~~~~~~   frame
 *
 * `planBuilding` now takes a {@link DoorSide}, so a band that has a road above
 * it *and* enough height for two buildings back to back gets a **north-facing
 * row** along its top edge, doors onto the road above. A street is then built up
 * on both sides:
 *
 *     ================   road
 *     ###  ####  ###     north-facing row — top-aligned, doors on its top edge
 *     ...................gap, so the two rows' roofs never touch
 *     ####  ###  ###     south-facing row — bottom-aligned, doors on its bottom edge
 *     ================   road
 *
 * The band is split into two height budgets, `floor((bandHeight - 1) / 2)` for
 * the north row and the rest for the south, with the spare row between them.
 * Both budgets must hold the shortest legal building or the band stays
 * single-sided — so this turns itself off on a short band rather than producing
 * two rows that overlap.
 *
 * Cross streets run the full height and intersect every road, which is what
 * makes the network connected **by construction** rather than by luck — the
 * same reasoning the dungeon generator uses for its corridors. They also cut
 * the frame at four points, so the town has entrances instead of being sealed
 * inside its own tree line.
 */

export interface TownOptions {
  width: number;
  height: number;
  seed: number;
  /** Tiles reserved around the edge for framing. */
  border: number;
  /** Thickness of every street. */
  roadWidth: number;
  /** Height of a building band, including the gap above the buildings. */
  bandHeight: number;
  /**
   * How far a single band's height may stray from {@link bandHeight}.
   *
   * **This is the town's grid, and it is the last one left.** P5-09 made every
   * street edge turn, so no boundary in a generated town runs straight for more
   * than 7 tiles — but the *pitch* was untouched: every band was `bandHeight`
   * tall, so every block in the town was the same size, and a block that can
   * only ever hold a 4-6 tile building is why the render still read as ruled
   * paper under the ragged edges.
   *
   * **Two, from the corpus.** `scripts/measure-map-shape.mjs` measures the
   * bounding box of every roof in the 293 sample maps: 233 components, height
   * **median 3, p90 5**, max 26. A hand-made building is typically 3 rows of
   * roof and sometimes 5, so the band that holds one has to vary by about two
   * rows for both to fit — and with a fixed band only one of them ever does.
   *
   * Zero restores the fixed pitch, which is the control the measurement below
   * was taken against.
   */
  bandHeightVariation: number;
  minBuildingWidth: number;
  maxBuildingWidth: number;
  minBuildingHeight: number;
  maxBuildingHeight: number;
  /** Rows of wall at the bottom of each building; the rest is roof. */
  wallHeight: number;
  /** Vertical streets. At least one, or the horizontal roads never meet. */
  crossStreets: number;
  /** Fraction of the free ground that gets a prop, 0-1. */
  decorDensity: number;
  /** Height of the props used to frame the map edge. */
  framePropHeight: number;
  /**
   * Build a north-facing row along the top of every band that has a road above
   * it and room for two buildings. Off leaves the town in horizontal bands with
   * the ground above each row unused.
   *
   * **Off by default, and the reason is what it looks like rather than what it
   * does.** The layout is sound — every door reaches a street, and a 44x46 town
   * at bandHeight 12 goes from 8 buildings to 12 with walkability still one
   * connected area of 1573 tiles. But a north-facing building has to put its
   * wall band above its roof, and the RTP roof sets are directional art: the
   * render shows the wall apparently standing *on* the roof, with the wall's own
   * drop shadow falling across it. That is the corpus count showing up visually
   * — 0 of 107 sample doors are entered from the north. So this is offered, not
   * chosen.
   */
  bothSidesOfStreet: boolean;
  /**
   * Give every street an edge that turns instead of a ruled line.
   *
   * **On by default, and the measurement is the reason.** P5-07 counted every
   * material boundary on layer 0: hand-made maps have a median run of 1 and a
   * p99 of 9, and this generator had a median of 4 and a max of 19 — the streets
   * being nearly all of it, since a building is only 4-7 tiles wide and can
   * never emit a long one. Off restores the ruled streets, which is worth having
   * for a deliberately formal town and for comparing the two.
   *
   * A street only ever widens: {@link ragged} is given `minThickness` equal to
   * `roadWidth`, so no seed can pinch a road, and it is told the building
   * footprints are unavailable, so no bulge eats a wall.
   */
  raggedRoads: boolean;
}

export const TOWN_DEFAULTS: Omit<TownOptions, 'width' | 'height' | 'seed'> = {
  border: 3,
  roadWidth: 2,
  bandHeight: 7,
  bandHeightVariation: 2,
  minBuildingWidth: 4,
  maxBuildingWidth: 7,
  minBuildingHeight: 4,
  maxBuildingHeight: 6,
  wallHeight: 2,
  crossStreets: 2,
  decorDensity: 0.08,
  framePropHeight: 2,
  // Off, and the render is the reason — see `bothSidesOfStreet` above and the
  // ROADMAP. The layout is sound; the RTP art is not on its side.
  bothSidesOfStreet: false,
  raggedRoads: true,
};

export interface TownBuilding {
  rect: Rect;
  wallHeight: number;
  /** Door column within the footprint. */
  doorOffsetX: number;
  /** Which edge of the footprint the door is on. */
  doorSide: DoorSide;
  /** Absolute door tile, and the tile the player stands on to use it. */
  door: { x: number; y: number; approach: { x: number; y: number } };
  /** Pick a roof with `variant % choices.length`. */
  variant: number;
}

export interface Slot {
  x: number;
  y: number;
}

export interface TownPlan {
  width: number;
  height: number;
  /** The rectangles the streets were planned as, kept for reporting. */
  roads: Rect[];
  /**
   * The cells the streets actually cover — the rectangles once their edges have
   * been made to turn. Everything downstream reads this rather than
   * {@link roads}, so a prop, a townsperson and a frame tree all agree with what
   * gets painted.
   */
  roadMask: boolean[][];
  /**
   * The longest straight run of the street/ground boundary, measured the way
   * P5-07 measured the corpus. The hand-made p99 is 9.
   */
  roadLongestRun: number;
  bands: Rect[];
  buildings: TownBuilding[];
  /** Free ground inside the town, chosen for props. */
  decorSlots: Slot[];
  /** Top-left cells for the framing props around the edge. */
  frameSlots: Slot[];
  warnings: string[];
}

export class TownError extends Error {}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/** Fisher-Yates, driven by the seeded RNG so a seed reproduces the whole plan. */
function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function planTown(options: TownOptions): TownPlan {
  const {
    width, height, seed, border, roadWidth, bandHeight, bandHeightVariation,
    minBuildingWidth, maxBuildingWidth, minBuildingHeight, maxBuildingHeight,
    wallHeight, crossStreets, decorDensity, framePropHeight, bothSidesOfStreet,
    raggedRoads,
  } = options;

  if (crossStreets < 1) {
    throw new TownError(
      'A town needs at least one cross street: the horizontal roads run parallel and only meet ' +
        'where a vertical one crosses them, so with none the streets would be disconnected.'
    );
  }
  // A nine-slice roof needs two rows, so a building is never shorter than
  // wallHeight + 2 — and the band has to hold one with a row to spare above it.
  const minHeight = Math.max(minBuildingHeight, wallHeight + 2);
  if (minHeight > maxBuildingHeight) {
    throw new TownError(
      `maxBuildingHeight ${maxBuildingHeight} is below the minimum a building can be ` +
        `(${minHeight} = wallHeight ${wallHeight} plus two roof rows).`
    );
  }
  if (bandHeight <= minHeight) {
    throw new TownError(
      `bandHeight ${bandHeight} leaves no gap above a ${minHeight}-tall building. Give the band ` +
        'at least one row more than the shortest building.'
    );
  }
  if (minBuildingWidth < 2) {
    throw new TownError('minBuildingWidth must be at least 2 — a nine-slice roof has no 1-wide form.');
  }

  const warnings: string[] = [];
  const rng = makeRng(seed);

  const usable: Rect = {
    x: border,
    y: border,
    width: width - border * 2,
    height: height - border * 2,
  };
  if (usable.width < minBuildingWidth + 2 || usable.height < bandHeight + roadWidth) {
    throw new TownError(
      `A ${width}x${height} map with a ${border}-tile border leaves ${usable.width}x${usable.height} ` +
        `to build in, which is not enough for one band (${bandHeight} rows) and its road ` +
        `(${roadWidth} rows). Make the map bigger or the border, band or buildings smaller.`
    );
  }

  // --- streets ---
  // Cross streets: spread across the usable width, jittered, never touching.
  //
  // They are decided **before** the band heights, and the ordering is
  // deliberate: they depend on the usable width alone, so drawing them first
  // means a change to how tall the bands are cannot move them. That is the same
  // discipline the ragging pass already follows, where the street edges reach
  // the rng only once every house has drawn from it.
  const verticals: Rect[] = [];
  const slotWidth = Math.floor(usable.width / crossStreets);
  if (slotWidth < roadWidth + minBuildingWidth + 2) {
    throw new TownError(
      `${crossStreets} cross streets leave only ${slotWidth} tiles between them, which cannot ` +
        `hold a road (${roadWidth}) and a ${minBuildingWidth}-wide building. Use fewer.`
    );
  }
  for (let i = 0; i < crossStreets; i++) {
    const lo = usable.x + i * slotWidth + 1;
    const hi = usable.x + (i + 1) * slotWidth - roadWidth - 1;
    const x = hi > lo ? randInt(rng, lo, hi) : lo;
    verticals.push({ x, y: 0, width: roadWidth, height });
  }

  // **Each band gets its own height**, so the town's blocks are not all one
  // size. The floor is `minHeight + 1` — the shortest band that still leaves a
  // building a row of clearance, which is the same bound the argument check
  // above applies to `bandHeight` itself — so a variation wider than the band
  // can absorb makes bands shorter down to that floor and no further.
  const bandFloor = minHeight + 1;
  const bandCeiling = bandHeight + bandHeightVariation;
  const roads: Rect[] = [...verticals];
  const bands: Rect[] = [];
  for (let y = usable.y; ; ) {
    const wanted = bandHeightVariation > 0
      ? randInt(rng, Math.max(bandFloor, bandHeight - bandHeightVariation), bandCeiling)
      : bandHeight;
    // The last band on the map takes whatever is left rather than being
    // dropped: a tall roll near the bottom edge would otherwise cost the town a
    // whole row of houses, which is a bigger change to the map than the band
    // height it came from.
    //
    // One row is held back below the last road. A street flush against the
    // bottom of the usable area has nowhere for its lower edge to bend into —
    // `raggedRect` may only grow inside the town — so that edge comes out as one
    // straight run the width of the map. Fixed bands only landed there on some
    // arithmetic; varying them made it common, and seed 5 of a 44x46 town
    // measured a **25-tile straight run against the corpus p99 of 9** before
    // this line existed.
    const room = usable.y + usable.height - y - roadWidth - 1;
    if (room < bandFloor) break;
    const bandRows = Math.min(wanted, room);
    bands.push({ x: usable.x, y, width: usable.width, height: bandRows });
    // Roads span the full map so they reach the edge and become entrances.
    roads.push({ x: 0, y: y + bandRows, width, height: roadWidth });
    y += bandRows + roadWidth;
  }
  if (bands.length === 0) {
    throw new TownError('The map is too short to hold a single band of buildings and its road.');
  }

  // --- buildings ---
  // The two rows of a band get separate height budgets with one spare row
  // between them, so a north-facing roof never touches the south-facing one
  // behind it. Both budgets have to hold the shortest legal building, or the
  // band stays single-sided rather than emitting two rows that overlap.
  const budgetsFor = (rows: number) => {
    const north = Math.floor((rows - 1) / 2);
    return { north, south: rows - 1 - north };
  };

  const buildings: TownBuilding[] = [];

  /** Lay one row of buildings along a band segment, facing `side`. */
  const layRow = (
    band: Rect,
    segment: { x: number; width: number },
    side: DoorSide,
    budget: number
  ): void => {
    // One tile of clearance at each end so a wall never sits flush against a
    // cross street.
    let x = segment.x + 1;
    const limit = segment.x + segment.width - 1;

    while (x + minBuildingWidth <= limit) {
      const maxW = Math.min(maxBuildingWidth, limit - x);
      const w = randInt(rng, minBuildingWidth, maxW);
      const h = randInt(rng, minHeight, Math.min(maxBuildingHeight, budget));

      // North-facing buildings hang from the top of the band and are entered
      // from the road above; south-facing ones sit on the bottom as before.
      const rect: Rect =
        side === 'top'
          ? { x, y: band.y, width: w, height: h }
          : { x, y: band.y + band.height - h, width: w, height: h };
      const doorOffsetX = w >= 3 ? randInt(rng, 1, w - 2) : 0;
      const doorX = rect.x + doorOffsetX;
      const doorY = side === 'top' ? rect.y : rect.y + rect.height - 1;
      const approachY = side === 'top' ? doorY - 1 : doorY + 1;

      buildings.push({
        rect,
        wallHeight,
        doorOffsetX,
        doorSide: side,
        door: { x: doorX, y: doorY, approach: { x: doorX, y: approachY } },
        variant: randInt(rng, 0, 1023),
      });

      x += w + randInt(rng, 1, 3);
    }
  };

  for (const [index, band] of bands.entries()) {
    // A band is cut into segments by the cross streets.
    const cuts = verticals
      .map((v) => ({ from: v.x, to: v.x + v.width }))
      .sort((a, b) => a.from - b.from);

    const segments: { x: number; width: number }[] = [];
    let cursor = band.x;
    for (const cut of cuts) {
      if (cut.from > cursor) segments.push({ x: cursor, width: cut.from - cursor });
      cursor = Math.max(cursor, cut.to);
    }
    if (cursor < band.x + band.width) {
      segments.push({ x: cursor, width: band.x + band.width - cursor });
    }

    // Band 0 has the map's border above it, not a road, so its top edge has
    // nothing to face. Every later band sits directly under the previous
    // band's road — `band.y - 1` is that road's last row.
    //
    // The two budgets are worked out from *this* band's height, so a short band
    // stays single-sided while a tall one beside it takes two rows.
    const { north: northBudget, south: southBudget } = budgetsFor(band.height);
    const northRow =
      bothSidesOfStreet && index > 0 && northBudget >= minHeight && southBudget >= minHeight;

    for (const segment of segments) {
      if (northRow) layRow(band, segment, 'top', northBudget);
      layRow(band, segment, 'bottom', northRow ? southBudget : band.height - 1);
    }
  }

  if (buildings.length === 0) {
    warnings.push(
      'No building fitted: every band segment was narrower than minBuildingWidth plus its ' +
        'clearance. The town is streets and scenery only.'
    );
  }

  // --- streets, as painted ---
  // Ragging happens *after* the buildings are laid out, and for two reasons.
  // The obvious one is that a street may only widen into ground nothing else
  // wants, so it has to know where the houses are. The quieter one is that the
  // building layout for a given seed is then untouched by this feature: the
  // rng reaches the road edges only once every house has drawn from it.
  const onBuilding: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  for (const building of buildings) {
    const r = building.rect;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) onBuilding[y][x] = true;
    }
  }

  const roadMask: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  for (const road of roads) {
    if (!raggedRoads) {
      for (let y = road.y; y < road.y + road.height; y++) {
        for (let x = road.x; x < road.x + road.width; x++) roadMask[y][x] = true;
      }
      continue;
    }
    // Only the long sides move. A street runs the full width or the full height
    // of the map so that it reaches the edge and becomes a way in; disturbing
    // its ends would take that away.
    const vertical = road.height > road.width;
    const patch = raggedRect({ ...road }, rng, {
      edges: vertical ? { left: true, right: true } : { top: true, bottom: true },
      minThickness: roadWidth,
      // A street may widen into open ground inside the town, and into nothing
      // else. Not into a house, for the obvious reason. **And not into the
      // border band**, for a reason worth writing down: the tree line is laid
      // as framePropHeight-tall props whose top half the player walks under, so
      // the walkable cells there are a chain of prop tops. A street bulging one
      // column deeper than its neighbour shifts that column's prop and breaks
      // the chain, stranding a tile under a canopy. Measured over 12 seeds of a
      // 44x46 town: bulges allowed through the border left **10 tiles cut off
      // under scenery, on 6 of the 12 seeds**; kept out of it, none. The street
      // still crosses the border — it just crosses it straight, which costs a
      // straight run as long as the border and no more.
      available: (x, y) =>
        x >= 0 && y >= 0 && x < width && y < height &&
        !onBuilding[y][x] && inRect(usable, x, y),
    });
    for (const cell of patch.cells) roadMask[cell.y][cell.x] = true;
  }

  const onRoad = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && roadMask[y][x];
  const roadLongestRun = longestBoundaryRun(roadMask);
  if (raggedRoads && roadLongestRun > RAGGED_DEFAULTS.maxRun) {
    warnings.push(
      `The streets still have a straight run ${roadLongestRun} tiles long, against a hand-made ` +
        `p99 of ${RAGGED_DEFAULTS.maxRun}. That happens where a street is boxed in — houses on ` +
        'one side and nowhere to widen on the other — so the edge had nowhere to turn to. ' +
        'A wider band or fewer buildings gives it room.'
    );
  }

  // --- what is taken ---
  const taken: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (roadMask[y][x] || onBuilding[y][x]) taken[y][x] = true;
    }
  }

  // --- frame ---
  // The outermost ring is left clear so the strip outside the trees stays
  // joined to the roads that cut through them; framing props fill the rest of
  // the border band.
  const frameSlots: Slot[] = [];
  const used: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const inFrame = (x: number, y: number): boolean =>
    x >= 1 && y >= 1 && x < width - 1 && y < height - 1 && !inRect(usable, x, y);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!inFrame(x, y) || used[y][x]) continue;
      let fits = true;
      for (let dy = 0; dy < framePropHeight; dy++) {
        if (!inFrame(x, y + dy) || used[y + dy][x] || onRoad(x, y + dy)) fits = false;
      }
      if (!fits) continue;
      for (let dy = 0; dy < framePropHeight; dy++) used[y + dy][x] = true;
      frameSlots.push({ x, y });
    }
  }

  // --- decoration ---
  // Only free ground inside the town, so nothing lands on a roof or in the
  // street — the placement audit finding, applied before anything is written
  // rather than reported after.
  //
  // Props are drawn from the tiles beside a wall or a street before the open
  // middle of a block. Scattering uniformly instead puts a lone crate in the
  // centre of a field, which is what the first render of this generator looked
  // like: things people leave outside belong against the things they belong to.
  const near: Slot[] = [];
  const far: Slot[] = [];
  const nextTo = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (taken[ny][nx]) return true;
      }
    }
    return false;
  };
  for (let y = usable.y; y < usable.y + usable.height; y++) {
    for (let x = usable.x; x < usable.x + usable.width; x++) {
      if (taken[y][x]) continue;
      (nextTo(x, y) ? near : far).push({ x, y });
    }
  }
  // **A prop may not seal ground the player can see into.** This is P5-43, and
  // it was measured rather than assumed: with the decoration pass turned off,
  // 0 of 12 seeds of a 44x46 town leave a walkable tile cut off; with it on and
  // no guard, 4 of 12 do — always exactly one tile, always the one-tile alley
  // between two houses with a prop landing above it and below it. The gap
  // between neighbours is `randInt(rng, 1, 3)` wide, so a one-tile alley is a
  // third of them.
  //
  // The guard is on the *slot*, not a repair afterwards, and that is what makes
  // it work where the earlier attempt did not. A repair pass has to decide
  // whether a prop already placed is blocking, which the plan cannot know — it
  // sees a prop, not the tileset flag that says whether the player walks
  // through it. Refusing a slot needs no such knowledge: it asks whether the
  // ground would still hold together **if every prop were solid**, and drops
  // the slot when it would not. Where a prop turns out to be passable that
  // costs one piece of decoration and nothing else; the guarantee holds
  // whatever the props are.
  //
  // Each slot is tested against every slot already kept, because the caller
  // gets the whole list and the tiles seal each other in pairs.
  const wanted = Math.floor((near.length + far.length) * decorDensity);
  const decorSlots = keepGroundJoined(
    [...shuffle(rng, near), ...shuffle(rng, far)],
    wanted,
    { width, height, onBuilding, frameSlots, framePropHeight }
  );

  return {
    width, height, roads, roadMask, roadLongestRun, bands, buildings,
    decorSlots, frameSlots, warnings,
  };
}

/**
 * Choose decoration slots that leave the ground in one piece.
 *
 * The ground here is every tile of the map that is not a building and not the
 * *solid* part of a frame prop. That second exclusion is the one worth stating:
 * the tree line is laid as `framePropHeight`-tall props whose **top row the
 * player walks under** — the same fact P5-09 used to keep streets out of the
 * border band — so only the rows below the top are treated as blocking here.
 * Getting that wrong in either direction costs a prop, never a hole: the walk
 * only ever refuses slots.
 *
 * Slots are taken in the order given until `wanted` have been kept, so a
 * refused slot is replaced by the next candidate rather than shrinking the
 * decoration budget.
 */
function keepGroundJoined(
  slots: Slot[],
  wanted: number,
  map: {
    width: number;
    height: number;
    onBuilding: boolean[][];
    frameSlots: Slot[];
    framePropHeight: number;
  }
): Slot[] {
  const { width, height, onBuilding, frameSlots, framePropHeight } = map;

  const ground: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (onBuilding[y][x]) continue;
      ground[y][x] = true;
      total++;
    }
  }
  for (const slot of frameSlots) {
    for (let dy = 1; dy < framePropHeight; dy++) {
      const y = slot.y + dy;
      if (y >= 0 && y < height && ground[y][slot.x]) {
        ground[y][slot.x] = false;
        total--;
      }
    }
  }

  const blocked: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  let blockedCount = 0;

  const joined = (): boolean => {
    let start: [number, number] | null = null;
    for (let y = 0; y < height && start === null; y++) {
      for (let x = 0; x < width; x++) {
        if (ground[y][x] && !blocked[y][x]) { start = [x, y]; break; }
      }
    }
    if (start === null) return true;

    const seen = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
    const queue: [number, number][] = [start];
    seen[start[1]][start[0]] = true;
    let reached = 0;
    while (queue.length > 0) {
      const [x, y] = queue.pop()!;
      reached++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (seen[ny][nx] || !ground[ny][nx] || blocked[ny][nx]) continue;
        seen[ny][nx] = true;
        queue.push([nx, ny]);
      }
    }
    return reached === total - blockedCount;
  };

  const kept: Slot[] = [];
  for (const slot of slots) {
    if (kept.length >= wanted) break;
    if (!ground[slot.y]?.[slot.x] || blocked[slot.y][slot.x]) continue;
    blocked[slot.y][slot.x] = true;
    blockedCount++;
    if (joined()) {
      kept.push(slot);
    } else {
      blocked[slot.y][slot.x] = false;
      blockedCount--;
    }
  }
  return kept;
}

/**
 * The plan as text: `#` building, `+` door, `=` road, `T` frame prop, `o` decor,
 * `.` open ground.
 */
export function renderTownAscii(plan: TownPlan): string {
  const grid: string[][] = Array.from({ length: plan.height }, () =>
    new Array<string>(plan.width).fill('.')
  );

  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (plan.roadMask[y][x]) grid[y][x] = '=';
    }
  }
  for (const slot of plan.frameSlots) grid[slot.y][slot.x] = 'T';
  for (const slot of plan.decorSlots) grid[slot.y][slot.x] = 'o';
  for (const building of plan.buildings) {
    const r = building.rect;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) grid[y][x] = '#';
    }
    grid[building.door.y][building.door.x] = '+';
  }

  return grid.map((row) => row.join('')).join('\n');
}

/**
 * Was that a town, or a map with streets on it?
 *
 * `generate_town` places its buildings one at a time and catches each
 * `BuildingPlacementError` into a list, so a run where *every* building was
 * refused still reached the end, wrote the file and reported itself a success —
 * the count `Buildings: 0 of 2 planned` was the only trace, in the middle of a
 * result that otherwise reads exactly like a working town.
 *
 * Two different ways to end with nothing, and they need different answers:
 *
 *  - **Nothing was planned.** `planTown` warns and carries on when no band
 *    segment is wide enough for `minBuildingWidth` plus its clearance. Measured
 *    over 4356 accepted plans (widths 17-60, heights 13-45, 3 seeds each, at
 *    `TOWN_DEFAULTS`): this happens at **width 22 in 93 of 93 plans, and at
 *    widths 23 and 24 in 31 of 93 each**. From width 25 up it never happens, and
 *    below 22 `planTown` already throws. So it is a narrow geometry window with
 *    a precise cause, not a normal outcome — worth naming rather than warning
 *    about.
 *  - **Everything planned was refused.** The building placer said no to each
 *    one, for a reason it already phrased well. The first of those reasons is
 *    almost always the whole story, since the refusals come from the arguments
 *    rather than from the individual plots.
 *
 * Where there is at least one building, a partial loss is *not* a refusal — a
 * town with 11 of 13 buildings is a town — but the count belongs on the line
 * that reports the buildings, not only in a block further down.
 *
 * For scale: those same 4356 plans place a median of 8 buildings and at most
 * 25, so 0 is far outside what any accepted plan produces.
 *
 * Pure: given three counts and the refusal texts, it returns what to say.
 */
export interface TownBuildOutcome {
  /** Refusal text when the result is not a town, else null. */
  refusal: string | null;
  /** What the buildings line should say. */
  summary: string;
}

export function assessTownBuild(
  planned: number,
  placed: number,
  failures: string[],
  minBuildingWidth: number
): TownBuildOutcome {
  if (planned === 0) {
    return {
      refusal:
        'No building fitted the plan: every band segment came out narrower than ' +
        `minBuildingWidth (${minBuildingWidth}) plus its clearance, so the town would be ` +
        'streets and scenery with nothing to enter. Nothing was written.\n\n' +
        'The map is too narrow for these settings. Widen it, lower minBuildingWidth, or use ' +
        'fewer cross streets — each cross street takes a road\'s width out of the space a ' +
        'building could stand in.',
      summary: 'Buildings: none planned.',
    };
  }

  if (placed === 0) {
    return {
      refusal:
        `All ${planned} planned building(s) were refused, so the map would have been streets ` +
        'and scenery with nothing to enter. Nothing was written.\n\n' +
        `The first refusal was: ${failures[0] ?? '(no reason recorded)'}\n\n` +
        'These come from the arguments rather than from the individual plots, so fixing that ' +
        'one usually fixes them all.',
      summary: `Buildings: 0 of ${planned} planned.`,
    };
  }

  const lost = failures.length;
  return {
    refusal: null,
    summary:
      lost === 0
        ? `Buildings: ${placed} of ${planned} planned`
        : `Buildings: ${placed} of ${planned} planned — ${lost} refused and lost`,
  };
}

/**
 * Where a townsperson may stand, worked out from the plan rather than
 * rediscovered from the finished map.
 *
 * `populate_map` is a second pass: it reads back a map it did not build, tells
 * floor from wall by passage flags, and recognises a door only by its sprite
 * name. The planner knows all of it outright — which rects are street, which
 * are plot, and (in `building.door.approach`) exactly which tile a door is used
 * from. Handing that down is both cheaper and a guarantee rather than an
 * inference.
 *
 * **The count does not come from the map's size, and that is measured.** Over
 * the 26 populated maps of `Wicked Heart` (64 maps, 63 NPC events), the Pearson
 * correlation between map area and NPC count is **r = 0.09** — none. The two
 * most crowded maps in the project are its *smallest*: 7 NPCs on 17x13, which
 * is 3.17 per 100 tiles, against 4 NPCs on 40x30, which is 0.33. Population
 * tracks what a place is, not how big it is, so `generate_town` takes a flat
 * count and does not scale it by area.
 *
 * The RPG Maker sample maps settle nothing here — **4 NPC events across all
 * 293** — so every number below comes from `Wicked Heart` and is labelled as
 * one project's habit rather than a rule.
 *
 * What is *not* settled by either corpus: whether a townsperson belongs on the
 * street or on the open ground between buildings. Neither corpus marks which
 * tiles are road, so this offers both and lets the connectivity check in
 * `planNpcPlacement` decide — a street tile sits in a wide corridor and
 * survives it, a tile in a one-wide gap between two buildings usually does not.
 */
export interface TownPeoplePlan {
  /** Tiles a townsperson may be considered for: street and open ground. */
  candidates: Slot[];
  /**
   * Tiles nobody may stand on. Every door's approach tile — the one the player
   * must step onto to open it. An NPC there does not seal the map off, so the
   * connectivity check would happily allow it, and the door would simply stop
   * working with nothing to say why.
   */
  blocked: Slot[];
}

export function planTownPeople(plan: TownPlan): TownPeoplePlan {
  const taken: boolean[][] = Array.from({ length: plan.height }, () =>
    new Array<boolean>(plan.width).fill(false)
  );

  const mark = (x: number, y: number) => {
    if (y >= 0 && y < plan.height && x >= 0 && x < plan.width) taken[y][x] = true;
  };

  // Building footprints are solid, and the props stand on their own tiles.
  for (const building of plan.buildings) {
    const r = building.rect;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) mark(x, y);
    }
  }
  for (const slot of plan.decorSlots) mark(slot.x, slot.y);
  for (const slot of plan.frameSlots) mark(slot.x, slot.y);

  const blocked = plan.buildings.map((b) => ({ ...b.door.approach }));
  for (const slot of blocked) mark(slot.x, slot.y);

  const candidates: Slot[] = [];
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (!taken[y][x]) candidates.push({ x, y });
    }
  }

  return { candidates, blocked };
}

/**
 * Which building is the shop, and where its keeper stands.
 *
 * `place_shop` needs a coordinate and `generate_town` builds the buildings;
 * neither knew about the other, so a generated town had no merchant unless one
 * was placed by hand on a tile the caller had to work out.
 *
 * **The corpus cannot settle where a shopkeeper stands, and this says so
 * rather than dressing a guess as a measurement.** Every shop page on this
 * machine — 4 of them — belongs to *one event* on *one map*: `EV003` on
 * `Wicked Heart`'s Map013, "Inn", a 19x15 **interior**. That event carries no
 * sprite at all on any of its 5 pages; the visible character is a separate
 * `Barkeeper` event one tile above it. So the single data point is "an
 * invisible trigger on a counter tile inside a building", which says nothing
 * about a merchant on a town street. The 293 sample maps have no shop at all.
 *
 * What the sample *does* confirm is the part that is the engine's anyway: the
 * page is Action Button, priority "same as characters", fixed movement, and 2
 * of the 4 pages are exactly `101, 401, 302, 605` — a greeting then the shop,
 * which is the shape `shopCommands` emits.
 *
 * So the two rules below are **stated judgements**, marked as such:
 *
 *  - **Which building.** The one whose door is nearest the middle of the map.
 *    A town's trade sits on its central street rather than at its edge. Ties go
 *    to the larger footprint, then to position, so the choice is reproducible
 *    without a seed — a shop is a fixed part of a map, the same reasoning
 *    `selectStock` uses for not randomising the shelf.
 *  - **Where the keeper stands.** Beside the door's approach tile, never on it.
 *    On it, the keeper would block the door: an NPC has priority "same as
 *    characters", so it occupies its tile, and the player could never open the
 *    shop's own building. Standing to one side reads as a merchant at their
 *    door and leaves the doorway clear.
 *
 * The keeper's tile is *offered*, not chosen: the candidates come back in
 * preference order and the caller runs them through `planNpcPlacement`, so the
 * shop inherits the same connectivity guarantee as every other townsperson.
 */
export interface TownShopPlan {
  /** The building the shop belongs to. */
  building: TownBuilding;
  /** Tiles the keeper could stand on, best first. Empty if none is free. */
  candidates: Slot[];
}

export function planTownShop(plan: TownPlan, people: TownPeoplePlan): TownShopPlan | null {
  if (plan.buildings.length === 0) return null;

  const cx = (plan.width - 1) / 2;
  const cy = (plan.height - 1) / 2;
  const area = (b: TownBuilding) => b.rect.width * b.rect.height;

  const building = [...plan.buildings].sort((a, b) => {
    const da = Math.abs(a.door.x - cx) + Math.abs(a.door.y - cy);
    const db = Math.abs(b.door.x - cx) + Math.abs(b.door.y - cy);
    if (da !== db) return da - db;
    if (area(a) !== area(b)) return area(b) - area(a);
    return a.rect.x - b.rect.x || a.rect.y - b.rect.y;
  })[0];

  const open = new Set(people.candidates.map((s) => `${s.x},${s.y}`));
  const { x: ax, y: ay } = building.door.approach;

  // Beside the approach first, then a step further along the same row, then
  // straight out into the street — which is away from the building, so it
  // follows the door's side. Left before right only to be deterministic.
  const outward = building.doorSide === 'top' ? -1 : 1;
  const wanted: Slot[] = [
    { x: ax - 1, y: ay }, { x: ax + 1, y: ay },
    { x: ax - 2, y: ay }, { x: ax + 2, y: ay },
    { x: ax, y: ay + outward },
  ];

  return {
    building,
    candidates: wanted.filter((s) => open.has(`${s.x},${s.y}`)),
  };
}
