import {
  TILE_ID_A3,
  TILE_ID_A4,
  TILE_ID_MAX,
  getAutotileKind,
  makeAutotileId,
  type Rect,
} from './autotile.js';
import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * Building blueprints — the composition rules that turn "put a house here" into
 * roof tiles, wall tiles and a door event.
 *
 * Everything below is per-tileset *content* rather than an engine rule, which is
 * why it lived as prose in the roadmap for so long. It is written down here
 * because it was measured, either by rendering the sheets or by counting the 293
 * hand-made sample maps in `RPG Maker MZ/samplemaps`:
 *
 *  - **A roof block sits on a wall block, and the wall is the A3 kind 8 below the
 *    roof.** Of 614 sample columns where an A3 roof run has an A3 run directly
 *    beneath it, 497 (81%) use `roofKind + 8`. The A3 sheet is laid out roof row
 *    / wall row / roof row / wall row, so block rows 0 and 2 are roofs and 1 and
 *    3 are walls.
 *
 *  - **Two rows is the usual height** for both parts: roof runs measure 2 rows
 *    304 times, 1 row 225, 3 rows 127; wall runs 2 rows 774 times, 1 row 423,
 *    3 rows 121.
 *
 *  - **A3 roof materials are flat texture, so real roofs come from the C sheet**
 *    as nine-slice sets with sloped sides and a shingled eave (finding 11 of the
 *    visual review). Those are addressed with the B/C/D/E sheet geometry, not
 *    the autotile one — see {@link nineSliceTileId}.
 *
 *  - **Nine-slice roofs never go on layer 0.** Of 537 roof-corner tiles in the
 *    sample maps, 0 are on layer 0, 477 on layer 3 and 58 on layer 2; 98.1% have
 *    something painted on a layer beneath them. The corner pieces are partly
 *    transparent, so with nothing under them they show the map background, which
 *    is black in game.
 *
 *  - **Doors are events, not tiles** (finding 13). 98 of 107 sample door events
 *    stand on a wall tile — the bottom row of the building — and the player
 *    walks into them from the tile below.
 *
 *  - **No sample building is entered from the north.** Re-measured with
 *    `scripts/measure-door-sides.mjs`, which asks a different question from the
 *    count above: not where the door *tile* is, but which neighbours the player
 *    could be standing on, via the tileset's passage flags and
 *    `Game_CharacterBase.canPass`. Of 107 door events on 36 maps, **88 have
 *    exactly one approach side and it is the bottom in 88 of 88**. Ten have no
 *    standable neighbour at all (decorative, walled in), and the remaining nine
 *    stand in open floor with 2-4 open sides, where "the side" is not a
 *    question. So {@link DoorSide} `'top'` has **no support in the corpus** and
 *    is a stated judgement — see {@link planBuilding}.
 *
 * This module is pure: it plans and builds structures, and never touches a file.
 */

// --- B/C/D/E sheet geometry -------------------------------------------------

/**
 * The object sheets are 16 tiles across but are addressed as two 8-wide halves:
 * `Tilemap._drawNormalTile` computes the source column as
 * `(floor(tileId / 128) % 2) * 8 + tileId % 8` and the row as
 * `floor((tileId % 256) / 8) % 16`.
 *
 * So within one half, +1 steps a column and +8 steps a row — which is what makes
 * `topLeft + row * 8 + col` the right way to address a nine-slice block, and
 * also what makes a block straddling the half boundary wrap to the other side of
 * the sheet.
 */
export const SHEET_HALF_WIDTH = 8;
export const TILES_PER_SHEET = 256;

export function sheetColumn(tileId: number): number {
  return (Math.floor(tileId / 128) % 2) * SHEET_HALF_WIDTH + (tileId % SHEET_HALF_WIDTH);
}

export function sheetRow(tileId: number): number {
  return Math.floor((tileId % TILES_PER_SHEET) / SHEET_HALF_WIDTH) % 16;
}

/** Address a cell of a nine-slice block laid out from `topLeft`. */
export function nineSliceTileId(topLeft: number, col: number, row: number): number {
  return topLeft + row * SHEET_HALF_WIDTH + col;
}

/**
 * Whether a 3x3 block starting at `topLeft` stays on the sheet. A block whose
 * left column is 6 or 7 of its half wraps to the other half; one starting in the
 * last two rows of the sheet runs off the bottom.
 */
export function nineSliceFits(topLeft: number): boolean {
  return topLeft % SHEET_HALF_WIDTH <= SHEET_HALF_WIDTH - 3 && sheetRow(topLeft) <= 13;
}

// --- Roof set catalogue -----------------------------------------------------

export interface RoofSet {
  name: string;
  /** Tile id of the block's top-left cell. */
  topLeft: number;
  /**
   * The pair of inner-corner eave pieces that let a roof turn a concave corner.
   * Nothing here uses them — {@link planBuilding} emits rectangles only — but
   * they are what an L-shaped roof would need, and they are hard to find again.
   */
  innerCorners: [number, number] | null;
}

/**
 * The roof sets on `Outside_C`, read off the sheet.
 *
 * **Tileset-specific.** Other C sheets lay their object tiles out completely
 * differently, so this table only applies when the map's tileset names
 * `Outside_C` as its C sheet — callers with a different tileset have to pass a
 * top-left tile id they found themselves.
 */
export const OUTSIDE_C_SHEET_NAME = 'Outside_C';

export const OUTSIDE_C_ROOF_SETS: RoofSet[] = [
  { name: 'green', topLeft: 384, innerCorners: [395, 396] },
  { name: 'white', topLeft: 389, innerCorners: [411, 412] },
  { name: 'gold', topLeft: 408, innerCorners: [427, 428] },
  // Brown's extras sit *below* its block rather than beside it, which is why an
  // earlier pass looked at the columns the other three use, found green and gold
  // dormers there, and recorded brown as having none. The sheet's own tile
  // labels put the whole set in one group and the render confirms the corners.
  { name: 'brown', topLeft: 413, innerCorners: [446, 447] },
];

export const ROOF_SET_NAMES = OUTSIDE_C_ROOF_SETS.map((s) => s.name);

export function findRoofSet(name: string): RoofSet | undefined {
  return OUTSIDE_C_ROOF_SETS.find((s) => s.name === name);
}

/**
 * Expand a nine-slice set over a rectangle: first and last column take the
 * sloped sides, first and last row the ridge and the eave, and everything
 * between repeats the middle.
 *
 * Needs at least 2x2 — with one column there is no cell that is not both the
 * left and the right edge, and the sets carry no single-width variant.
 */
export function nineSliceGrid(topLeft: number, width: number, height: number): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    const sr = y === 0 ? 0 : y === height - 1 ? 2 : 1;
    for (let x = 0; x < width; x++) {
      const sc = x === 0 ? 0 : x === width - 1 ? 2 : 1;
      row.push(nineSliceTileId(topLeft, sc, sr));
    }
    grid.push(row);
  }
  return grid;
}

// --- A3 roof / wall pairing -------------------------------------------------

export const A3_KIND_MIN = getAutotileKind(TILE_ID_A3);
export const A3_KIND_MAX = getAutotileKind(TILE_ID_A4) - 1;
export const A4_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

export function isA3Kind(kind: number): boolean {
  return kind >= A3_KIND_MIN && kind <= A3_KIND_MAX;
}

/** A3 block rows alternate roof / wall, starting with a roof row. */
export function isA3RoofKind(kind: number): boolean {
  return isA3Kind(kind) && Math.floor((kind - A3_KIND_MIN) / 8) % 2 === 0;
}

export function isA3WallKind(kind: number): boolean {
  return isA3Kind(kind) && Math.floor((kind - A3_KIND_MIN) / 8) % 2 === 1;
}

/** The wall that belongs under an A3 roof: the same column, one block row down. */
export function pairedWallKind(roofKind: number): number {
  return roofKind + 8;
}

// --- Planning ---------------------------------------------------------------

export type RoofPlan =
  | { style: 'nineslice'; topLeft: number }
  | { style: 'autotile'; kind: number };

/**
 * Which edge of the footprint the door sits on, and therefore which edge carries
 * the wall band. `'bottom'` is the default and the only one the corpus supports.
 */
export type DoorSide = 'bottom' | 'top';

export const DOOR_SIDES: DoorSide[] = ['bottom', 'top'];

export interface BuildingSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rows of wall along the door's edge of the footprint; the rest is roof. */
  wallHeight: number;
  wallKind: number;
  roof: RoofPlan;
  /** Column of the door within the footprint, or null for no door. */
  doorOffsetX: number | null;
  /** Which edge the door — and so the wall band — is on. Default `'bottom'`. */
  doorSide?: DoorSide;
}

export interface DoorPlacement {
  x: number;
  y: number;
  /** The tile the player stands on to use the door. */
  approach: { x: number; y: number };
  /** Which edge of the building this door is on. */
  side: DoorSide;
}

export interface BuildingPlan {
  roofRect: Rect;
  wallRect: Rect;
  /** Nine-slice roof tiles, `grid[y][x]` over `roofRect`. Null for an A3 roof. */
  roofTiles: number[][] | null;
  /** Base tile id for an A3 roof, before shape computation. Null otherwise. */
  roofTileId: number | null;
  wallTileId: number;
  door: DoorPlacement | null;
  warnings: string[];
}

export class BlueprintError extends Error {}

/**
 * Work out what a building is made of. Throws {@link BlueprintError} for a spec
 * that cannot produce a sane building, and collects the merely questionable
 * parts into `warnings` so the caller can report them rather than guess.
 *
 * ## Which edge the door is on
 *
 * A door has to stand on a wall tile — a door sprite drawn over roof art is a
 * door painted on a roof — so the wall band goes on the door's edge and the roof
 * fills the rest. `doorSide: 'bottom'` is the shipped idiom: roof above, wall
 * below, entered from the tile beneath. `'top'` inverts that, wall band at the
 * top of the footprint and roof below it, entered from the tile above.
 *
 * **`'top'` is a stated judgement and the corpus argues against it.** Of the 107
 * sample door events, the 88 whose approach is unambiguous are approached from
 * below in 88 of 88; not one building in the 293 maps is entered from the north.
 * The RTP roof sets are directional art — a nine-slice block is ridge / middle /
 * eave read downward — so there is no "seen from the north" roof to draw, and a
 * top-door building necessarily shows its roof *in front of* its wall. It exists
 * because it lets a town use the ground on both sides of a street instead of
 * only below it, and it is opt-in for that reason.
 *
 * The door *event* needed nothing: verified against `rmmz_objects.js` v1.9.0,
 * `ROUTE_TURN_LEFT`/`RIGHT`/`UP` are `setDirection(4|6|8)`, so the door's four
 * "directions" are the four rows of the `!Door1` sheet — closed through open —
 * and play the same animation whichever side you come from; and
 * `Game_Character.moveForward` is `moveStraight(this.direction())`, the
 * *player's* facing, which already points into the door because they walked into
 * it. Of the three things that looked baked in, only the approach tile was.
 */
export function planBuilding(spec: BuildingSpec): BuildingPlan {
  const { x, y, width, height, wallHeight, wallKind, roof, doorOffsetX } = spec;
  const doorSide: DoorSide = spec.doorSide ?? 'bottom';
  const warnings: string[] = [];

  if (width < 1 || height < 1) {
    throw new BlueprintError('A building needs a footprint at least 1x1.');
  }
  if (wallHeight < 1) {
    throw new BlueprintError('A building needs at least one row of wall.');
  }
  if (wallHeight >= height) {
    throw new BlueprintError(
      `wallHeight ${wallHeight} leaves no room for a roof in a ${height}-tall footprint. ` +
        'The roof rows sit on top of the wall rows, so height must exceed wallHeight.'
    );
  }

  const roofHeight = height - wallHeight;
  // The wall band sits on the door's edge; the roof takes what is left.
  const roofRect: Rect =
    doorSide === 'top'
      ? { x, y: y + wallHeight, width, height: roofHeight }
      : { x, y, width, height: roofHeight };
  const wallRect: Rect =
    doorSide === 'top'
      ? { x, y, width, height: wallHeight }
      : { x, y: y + roofHeight, width, height: wallHeight };

  // A3 (48-79) and A4 (80-127) both carry walls; anything else is not a wall material.
  if (wallKind < A3_KIND_MIN || wallKind > A4_KIND_MAX) {
    throw new BlueprintError(
      `Wall kind ${wallKind} is outside the wall families — A3 is ${A3_KIND_MIN}-${A3_KIND_MAX} ` +
        `and A4 is ${A3_KIND_MAX + 1}-${A4_KIND_MAX}.`
    );
  }
  if (isA3Kind(wallKind) && !isA3WallKind(wallKind)) {
    warnings.push(
      `A3 kind ${wallKind} is on a roof row of the sheet, not a wall row — the A3 sheet ` +
        'alternates roof row / wall row, so wall kinds are 56-63 and 72-79. The block will ' +
        'render as roof texture standing on end.'
    );
  }

  let roofTiles: number[][] | null = null;
  let roofTileId: number | null = null;

  if (roof.style === 'nineslice') {
    if (!nineSliceFits(roof.topLeft)) {
      throw new BlueprintError(
        `Tile ${roof.topLeft} cannot start a 3x3 block: it is too close to the edge of its ` +
          'half of the sheet, so the block would wrap. The object sheets are addressed as two ' +
          '8-wide halves.'
      );
    }
    if (width < 2 || roofHeight < 2) {
      throw new BlueprintError(
        `A nine-slice roof needs at least 2x2 roof tiles; this footprint gives ${width}x${roofHeight}. ` +
          'The sets have no single-width or single-height variant. Widen the building, reduce ' +
          'wallHeight, or use an A3 roof kind instead.'
      );
    }
    roofTiles = nineSliceGrid(roof.topLeft, width, roofHeight);
  } else {
    if (!isA3Kind(roof.kind)) {
      throw new BlueprintError(
        `Roof kind ${roof.kind} is not an A3 kind (${A3_KIND_MIN}-${A3_KIND_MAX}).`
      );
    }
    if (!isA3RoofKind(roof.kind)) {
      warnings.push(
        `A3 kind ${roof.kind} is on a wall row of the sheet, not a roof row — roof kinds are ` +
          '48-55 and 64-71.'
      );
    } else if (isA3Kind(wallKind) && wallKind !== pairedWallKind(roof.kind)) {
      warnings.push(
        `Roof kind ${roof.kind} is usually paired with wall kind ${pairedWallKind(roof.kind)} ` +
          `(the same column one block row down), not ${wallKind}. Independently chosen roof and ` +
          'wall materials are what make hand-assembled buildings look mismatched: 81% of the ' +
          "sample maps' roof-over-wall columns use the +8 pairing."
      );
    }
    roofTileId = makeAutotileId(roof.kind, 0);
  }

  let door: DoorPlacement | null = null;
  if (doorOffsetX !== null) {
    if (doorOffsetX < 0 || doorOffsetX >= width) {
      throw new BlueprintError(
        `Door offset ${doorOffsetX} is outside the ${width}-wide footprint.`
      );
    }
    const doorX = x + doorOffsetX;
    // The door goes on the outermost row of the wall band, so it faces the
    // street rather than sitting one row into the building.
    const doorY = doorSide === 'top' ? y : y + height - 1;
    const approachY = doorSide === 'top' ? doorY - 1 : doorY + 1;
    door = { x: doorX, y: doorY, approach: { x: doorX, y: approachY }, side: doorSide };
  }

  return {
    roofRect,
    wallRect,
    roofTiles,
    roofTileId,
    wallTileId: makeAutotileId(wallKind, 0),
    door,
    warnings,
  };
}

// --- The door event ---------------------------------------------------------

/**
 * Move route command codes, from Game_Character in rmmz_objects.js. A door
 * sprite's four "directions" are its four animation frames, so turning the event
 * is how the opening animation is played.
 */
const ROUTE_END = 0;
const ROUTE_MOVE_FORWARD = 12;
const ROUTE_WAIT = 15;
const ROUTE_TURN_LEFT = 17;
const ROUTE_TURN_RIGHT = 18;
const ROUTE_TURN_UP = 19;
const ROUTE_THROUGH_ON = 37;

const CODE_PLAY_SE = 250;
const CODE_SET_MOVE_ROUTE = 205;
const CODE_MOVE_ROUTE_STEP = 505;
const CODE_TRANSFER_PLAYER = 201;
const CODE_END = 0;

const THIS_EVENT = 0;
const THE_PLAYER = -1;

interface RouteStep {
  code: number;
  parameters?: unknown[];
}

function audio(name: string): { name: string; volume: number; pitch: number; pan: number } {
  return { name, volume: 90, pitch: 100, pan: 0 };
}

/**
 * A Set Movement Route command is stored twice: once inside the 205 command's
 * parameters, and once as a run of 505 lines mirroring every step except the
 * trailing end marker. Writing only the 205 leaves the editor showing an empty
 * route.
 */
function moveRouteCommands(
  target: number,
  steps: RouteStep[],
  options: { skippable: boolean; wait: boolean }
): EventCommand[] {
  const list = [...steps, { code: ROUTE_END }];
  const route = { repeat: false, skippable: options.skippable, wait: options.wait, list };
  return [
    { code: CODE_SET_MOVE_ROUTE, indent: 0, parameters: [target, route] },
    ...steps.map((step) => ({
      code: CODE_MOVE_ROUTE_STEP,
      indent: 0,
      parameters: [step] as unknown[],
    })),
  ];
}

export interface DoorTarget {
  mapId: number;
  x: number;
  y: number;
}

export interface DoorOptions {
  characterName?: string;
  characterIndex?: number;
  /** Where the door leads. Omit to emit the animation with no transfer. */
  target?: DoorTarget;
  openSe?: string;
  moveSe?: string;
}

/**
 * The door opening itself, without the transfer: play the open SE, step the
 * sprite through its three opening frames, turn Through on so the player can
 * walk into the doorway, then move the player forward.
 *
 * Split out from {@link doorEventPage} so a door that asks for a key can put
 * this run inside a conditional branch — see `locked-door.ts`. The commands are
 * emitted at indent 0; the caller shifts them if they are going in a branch.
 */
export function doorOpenCommands(options: { openSe?: string } = {}): EventCommand[] {
  const { openSe = 'Open1' } = options;

  return [
    { code: CODE_PLAY_SE, indent: 0, parameters: [audio(openSe)] },
    ...moveRouteCommands(
      THIS_EVENT,
      [
        { code: ROUTE_TURN_LEFT },
        { code: ROUTE_WAIT, parameters: [3] },
        { code: ROUTE_TURN_RIGHT },
        { code: ROUTE_WAIT, parameters: [3] },
        { code: ROUTE_TURN_UP },
        { code: ROUTE_THROUGH_ON },
      ],
      { skippable: false, wait: true }
    ),
    ...moveRouteCommands(THE_PLAYER, [{ code: ROUTE_MOVE_FORWARD }], {
      skippable: true,
      wait: true,
    }),
  ];
}

/**
 * Where the door leads: the travel SE and the transfer.
 *
 * **Nothing may follow this in a map event's list.** `Game_Player.performTransfer`
 * calls `Game_Map.setup`, which rebuilds `_events` from scratch — the running
 * `Game_Event` and its interpreter are thrown away with it, so commands after a
 * 201 never run. Anything the door has to remember has to be written first.
 */
export function doorTransferCommands(target: DoorTarget, moveSe = 'Move1'): EventCommand[] {
  return [
    { code: CODE_PLAY_SE, indent: 0, parameters: [audio(moveSe)] },
    // [designation, mapId, x, y, direction (0 = retain), fade (0 = black)]
    {
      code: CODE_TRANSFER_PLAYER,
      indent: 0,
      parameters: [0, target.mapId, target.x, target.y, 0, 0],
    },
  ];
}

/**
 * The canonical RPG Maker door page, matching the one the shipped sample maps
 * use (60 of the 107 sample door pages are this exact command sequence):
 * play the open SE, step the sprite through its three opening frames, turn
 * Through on so the player can walk into the doorway, move the player forward,
 * then transfer.
 *
 * Trigger is Player Touch with priority "same as characters", so walking into
 * the door opens it — that is what 46 of the sample pages do, more than any
 * other combination.
 */
export function doorEventPage(options: DoorOptions = {}): EventPage {
  const {
    characterName = '!Door1',
    characterIndex = 0,
    target,
    openSe = 'Open1',
    moveSe = 'Move1',
  } = options;

  const list: EventCommand[] = [...doorOpenCommands({ openSe })];

  if (target) list.push(...doorTransferCommands(target, moveSe));

  list.push({ code: CODE_END, indent: 0, parameters: [] });

  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: 'A',
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { characterIndex, characterName, direction: 2, pattern: 1, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: { list: [{ code: ROUTE_END, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 1,
    walkAnime: false,
  };
}

export function doorEvent(id: number, x: number, y: number, options: DoorOptions = {}): Event {
  return { id, name: `Door${id}`, note: '', pages: [doorEventPage(options)], x, y };
}

/** A door page carrying a !Door sprite is how RPG Maker marks a doorway. */
export function isDoorPage(page: EventPage): boolean {
  return /^!Door/.test(page.image?.characterName ?? '');
}

export function isDoorEvent(event: Event): boolean {
  return event.pages.some(isDoorPage);
}

/**
 * Point an existing door at a destination, filling in the transfer a door built
 * without one is missing.
 *
 * Returns whether the door already had a transfer. When it does not, the SE and
 * the transfer are appended before the page's end marker rather than after it —
 * a command after code 0 is never reached, so appending naively would produce a
 * door that still goes nowhere while looking wired up.
 */
export function setDoorDestination(page: EventPage, target: DoorTarget): boolean {
  const transfer = page.list.find((c) => c.code === CODE_TRANSFER_PLAYER);
  if (transfer) {
    transfer.parameters = [0, target.mapId, target.x, target.y, 0, 0];
    return true;
  }

  const end = page.list.findIndex((c) => c.code === CODE_END);
  const at = end === -1 ? page.list.length : end;
  page.list.splice(
    at,
    0,
    { code: CODE_PLAY_SE, indent: 0, parameters: [audio('Move1')] },
    {
      code: CODE_TRANSFER_PLAYER,
      indent: 0,
      parameters: [0, target.mapId, target.x, target.y, 0, 0],
    }
  );
  return false;
}
