import { makeRng } from './mapgen.js';
import { TILE_ID_A5, type Rect } from './autotile.js';
import { cutRoomCorners, columnSpan, type CornerCut } from './room-shape.js';
import { transferEventPage, STAIR_SE } from './stairs.js';
import type { EventPage, Event } from '../schemas/event.js';

/**
 * Interior rooms.
 *
 * The shape of a room is not a matter of taste — it is what the 113 interior
 * maps shipped with the editor all do, measured rather than invented:
 *
 *  - **The space around the room is A5 tile 1536**, the first tile of the A5
 *    sheet, in 436 of 452 sample-map corners. It reads as solid black, so the
 *    room appears to float in nothing, which is exactly what an RPG Maker
 *    interior looks like.
 *  - **The room is ringed by an A4 wall *top*** — the flat top of the wall seen
 *    from above — with the wall *face* drawn beneath it. Wall tops sit on the
 *    A4 sheet's even block rows and wall faces on the odd ones, and the face
 *    that belongs to a top is the kind 8 below it: `+8` in 2,066 of the 2,704
 *    top-over-face columns counted, the same pairing the A3 roofs use.
 *  - **The wall face is two rows tall**, in 2,504 of 3,660 measured runs
 *    (1 row: 620, 3 rows: 532).
 *  - **The front wall is drawn the same way but below the room**, so the bottom
 *    ring has two more rows of face beneath it, and the doorway is a channel cut
 *    straight down through all three.
 *
 * The exit is an event, like the door that leads here: no sprite, player touch,
 * priority below characters, playing an SE and transferring. 144 of the 147
 * sample exit events are exactly that.
 *
 * **The room is no longer always a rectangle**, and that too is measured — see
 * {@link ./room-shape.ts}. Of 191 hand-made room cores, only 81 (42.4%) are
 * rectangles and 85 (44.5%) are missing a bounding-box corner, so the floor is
 * a {@link cutRoomCorners} mask and the walls follow whatever silhouette it
 * hands over. **Everything above still holds cell for cell** — the wall builder
 * below reproduces the old rectangle exactly when no corner is cut, which is
 * asserted rather than assumed.
 *
 * One extra thing had to be measured to generalise the front wall. Beneath the
 * bottom ring the wall face was drawn the full width of the room, *including*
 * under the side wall columns, and it was not obvious whether that was the
 * corpus or a convenience. It is the corpus: taking every bottom-left room
 * corner that has a wall face below it, the cell one column further out on the
 * same face row is **another face in 186 of 231 cases (80.5%)**, a wall top in
 * the other 45. So the front face spreads sideways along its row, and that is
 * what the builder does.
 *
 * This module plans and builds; it never touches a file.
 */

/** The A5 tile that fills the space around a room. */
export const VOID_TILE = TILE_ID_A5;

/** Rows of wall face beneath a wall top. */
export const WALL_FACE_ROWS = 2;

export type Cell = 'void' | 'wallTop' | 'wallFace' | 'floor';

export interface InteriorOptions {
  /** Walkable floor inside the room. */
  floorWidth: number;
  floorHeight: number;
  /** Void border between the room and the map edge. */
  margin: number;
  /** Doorway column, measured across the floor. Null centres it. */
  doorOffsetX: number | null;
  seed: number;
  /**
   * Take corners out of the floor so the room is not a box.
   *
   * **On by default, from the corpus.** 106 of 191 hand-made room cores have no
   * corner cut and 85 do, and this reproduces that ratio rather than cutting
   * every room — so a little over half of all seeds still come out rectangular,
   * which is the point. Off gives the plain rectangle every time, which is
   * worth having for a room whose furniture layout the caller has planned.
   */
  cutCorners?: boolean;
}

/**
 * Cells that have to survive in every row and column of an interior floor.
 *
 * **Three, not the module's default of two, and the doorway is the reason.**
 * A room narrower than three has no wall either side of its doorway, which is
 * already why `floorWidth < 3` is refused outright; a corner cut that took the
 * floor's bottom row down to two would reintroduce exactly that, one seed in
 * however many. Asking for three everywhere makes it unreachable, at the cost
 * of leaving a 3-wide room a rectangle — which it has to be anyway.
 */
const INTERIOR_MIN_SPAN = 3;

export interface Slot {
  x: number;
  y: number;
}

export interface InteriorPlan {
  width: number;
  height: number;
  /** `cells[y][x]` — what belongs on the ground layer. */
  cells: Cell[][];
  /**
   * The walkable floor's bounding box, not counting the doorway channel. With
   * a corner cut this is larger than the floor itself; {@link floorMask} says
   * which of its cells are actually floor.
   */
  floor: Rect;
  /** `floorMask[y][x]` over {@link floor} — the room's silhouette. */
  floorMask: boolean[][];
  /** The corners taken out of the floor, empty for a rectangular room. */
  cuts: CornerCut[];
  /** The wall ring, outermost wall-top rectangle. */
  room: Rect;
  /** Where an inbound transfer should land: the gap in the front wall. */
  arrival: Slot;
  /** Where the exit event goes: the bottom of the doorway channel. */
  exit: Slot;
  /** Floor tiles against a wall, clear of the way in — for furniture. */
  furnitureSlots: Slot[];
}

export class InteriorError extends Error {}

function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the wall structure around an arbitrary floor silhouette.
 *
 * Written per column rather than per row, which is what lets it take any shape
 * `cutRoomCorners` produces: every column of that mask is a single unbroken
 * interval of floor, so each column has exactly one back wall above its floor
 * and one front wall below it, and there is never a second run to disambiguate.
 *
 * Four rules, in order, and each is one of the measurements at the top of this
 * file:
 *
 *  1. Above each column's floor: {@link WALL_FACE_ROWS} of face, capped by one
 *     row of top. That is the back wall — face two rows tall in 2,504 of 3,660
 *     runs.
 *  2. Below it: one row of top — the ring — then {@link WALL_FACE_ROWS} of face.
 *     That is the front wall.
 *  3. Beside a floor cell, a top. Walls seen edge-on show only their top.
 *  4. Anything left inside the room's silhouette is a top, **except** where the
 *     front wall face reaches it sideways along its own row — 186 of 231, the
 *     measurement that keeps the bottom band full width.
 *
 * With no corner cut this produces the previous rectangle cell for cell, which
 * is a test rather than a claim.
 */
function buildWalls(
  width: number,
  height: number,
  isFloor: (x: number, y: number) => boolean,
  columns: { x: number; top: number; bottom: number }[]
): Cell[][] {
  const cells: Cell[][] = Array.from({ length: height }, () => new Array<Cell>(width).fill('void'));
  const frontFace: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  const inBounds = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height;
  const set = (x: number, y: number, cell: Cell): void => {
    if (inBounds(x, y) && cells[y][x] === 'void') cells[y][x] = cell;
  };

  for (const column of columns) {
    for (let y = column.top; y <= column.bottom; y++) {
      if (inBounds(column.x, y)) cells[y][column.x] = 'floor';
    }
  }

  // 1 and 2: each column's own back and front wall.
  for (const column of columns) {
    for (let row = 1; row <= WALL_FACE_ROWS; row++) {
      set(column.x, column.top - row, 'wallFace');
    }
    set(column.x, column.top - WALL_FACE_ROWS - 1, 'wallTop');

    set(column.x, column.bottom + 1, 'wallTop');
    for (let row = 2; row <= WALL_FACE_ROWS + 1; row++) {
      const y = column.bottom + row;
      set(column.x, y, 'wallFace');
      if (inBounds(column.x, y) && cells[y][column.x] === 'wallFace') frontFace[y][column.x] = true;
    }
  }

  // 3: the side walls.
  for (const column of columns) {
    for (let y = column.top; y <= column.bottom; y++) {
      set(column.x - 1, y, 'wallTop');
      set(column.x + 1, y, 'wallTop');
    }
  }

  // The room's silhouette: the floor grown a column each way and a full wall
  // block up and down. Everything inside it that is still unassigned is part of
  // the room and has to be drawn as something.
  const reach = WALL_FACE_ROWS + 1;
  const silhouette: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(false)
  );
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFloor(x, y)) continue;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (inBounds(x + dx, y + dy)) silhouette[y + dy][x + dx] = true;
        }
      }
    }
  }

  // 4a: the front face spreads sideways through the silhouette, so the band
  // beneath the room runs its full width and not only the floor's columns.
  for (let y = 0; y < height; y++) {
    const queue: number[] = [];
    for (let x = 0; x < width; x++) if (frontFace[y][x]) queue.push(x);
    while (queue.length > 0) {
      const x = queue.pop()!;
      for (const nx of [x - 1, x + 1]) {
        if (nx < 0 || nx >= width) continue;
        if (!silhouette[y][nx] || frontFace[y][nx]) continue;
        if (cells[y][nx] !== 'void') continue;
        cells[y][nx] = 'wallFace';
        frontFace[y][nx] = true;
        queue.push(nx);
      }
    }
  }

  // 4b: whatever is left of the silhouette is wall top.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (silhouette[y][x] && cells[y][x] === 'void') cells[y][x] = 'wallTop';
    }
  }

  return cells;
}

export function planInterior(options: InteriorOptions): InteriorPlan {
  const { floorWidth, floorHeight, margin, seed } = options;
  const cutCorners = options.cutCorners ?? true;

  if (floorWidth < 3 || floorHeight < 2) {
    throw new InteriorError(
      `A room needs at least a 3x2 floor; ${floorWidth}x${floorHeight} was asked for. Narrower ` +
        'than three leaves no wall either side of the doorway.'
    );
  }
  if (margin < 0) throw new InteriorError('margin cannot be negative.');

  // outer width = floor + a wall each side
  // outer height = top ring + top face + floor + bottom ring + bottom face
  const roomWidth = floorWidth + 2;
  const roomHeight = 1 + WALL_FACE_ROWS + floorHeight + 1 + WALL_FACE_ROWS;
  const width = roomWidth + margin * 2;
  const height = roomHeight + margin * 2;

  const room: Rect = { x: margin, y: margin, width: roomWidth, height: roomHeight };
  const floor: Rect = {
    x: room.x + 1,
    y: room.y + 1 + WALL_FACE_ROWS,
    width: floorWidth,
    height: floorHeight,
  };

  // The shape is drawn before the doorway is chosen, because which columns can
  // hold a doorway depends on it.
  const rng = makeRng(seed);
  const shape = cutRoomCorners(floorWidth, floorHeight, rng, {
    minSpan: INTERIOR_MIN_SPAN,
    ...(cutCorners ? {} : { cornerWeights: [1, 0, 0, 0, 0] }),
  });
  const floorMask = shape.mask;
  const isFloor = (x: number, y: number): boolean =>
    x >= floor.x &&
    y >= floor.y &&
    x < floor.x + floor.width &&
    y < floor.y + floor.height &&
    floorMask[y - floor.y][x - floor.x];

  const columns: { x: number; top: number; bottom: number }[] = [];
  for (let dx = 0; dx < floorWidth; dx++) {
    const span = columnSpan(floorMask, dx);
    if (span === null) continue; // cutRoomCorners never empties a column
    columns.push({ x: floor.x + dx, top: floor.y + span.top, bottom: floor.y + span.bottom });
  }

  // **The doorway goes in a column that reaches the floor's bottom row.** Any
  // other column's front wall stops short of the room's own bottom, so a
  // channel cut down it would open into the void partway up the map instead of
  // out of the front of the house.
  //
  // Every such column has a wall either side of the channel whatever the shape,
  // because the room's silhouette is the floor grown a column each way — which
  // is why the ends of the run are *not* excluded here, and why a door at
  // offset 0 of a rectangular room still sits against that room's side wall,
  // exactly as it did before there were any shapes.
  const bottomRow = floor.y + floor.height - 1;
  const usableDoorColumns = columns
    .filter((c) => c.bottom === bottomRow)
    .map((c) => c.x - floor.x)
    .sort((a, b) => a - b);
  if (usableDoorColumns.length === 0) {
    throw new InteriorError(
      'No column of the floor reaches its bottom row, so there is nowhere to cut a doorway. ' +
        'This should be unreachable — report the seed.'
    );
  }

  const requested = options.doorOffsetX;
  if (requested !== null && (requested < 0 || requested >= floorWidth)) {
    throw new InteriorError(`Doorway offset ${requested} is outside a ${floorWidth}-wide floor.`);
  }
  let doorOffsetX: number;
  if (requested === null) {
    // The middle of the run that reaches the bottom, which is the floor's own
    // middle whenever no corner was cut out of the bottom.
    doorOffsetX = usableDoorColumns[Math.floor(usableDoorColumns.length / 2)];
  } else if (usableDoorColumns.includes(requested)) {
    doorOffsetX = requested;
  } else {
    throw new InteriorError(
      `Doorway offset ${requested} does not reach the front of the room: a corner cut out of the ` +
        `floor leaves columns ${usableDoorColumns[0]}-${usableDoorColumns[usableDoorColumns.length - 1]} ` +
        'facing the street. Ask for one of those, or pass cutCorners: false for a square room.'
    );
  }

  const cells = buildWalls(width, height, isFloor, columns);

  // The doorway is a channel straight down through the front wall.
  const doorX = floor.x + doorOffsetX;
  const bottomRingY = bottomRow + 1;
  for (let y = bottomRingY; y < room.y + room.height; y++) cells[y][doorX] = 'floor';

  const arrival: Slot = { x: doorX, y: bottomRingY };
  const exit: Slot = { x: doorX, y: room.y + room.height - 1 };

  // Furniture goes against a wall, and never in the doorway column — that
  // column is the only way in and out, so anything standing in it seals the
  // room. Blocked entrances were exactly what the placement audit was written
  // to catch, so the generator does not create them in the first place.
  //
  // "Against a wall" is now "has a neighbour that is not floor", which is the
  // same set of cells for a rectangle and picks up the concave corner of a
  // shaped room as well.
  const againstWall: Slot[] = [];
  for (const column of columns) {
    for (let y = column.top; y <= column.bottom; y++) {
      if (column.x === doorX) continue;
      const touchesWall =
        !isFloor(column.x - 1, y) ||
        !isFloor(column.x + 1, y) ||
        !isFloor(column.x, y - 1) ||
        !isFloor(column.x, y + 1);
      if (touchesWall) againstWall.push({ x: column.x, y });
    }
  }

  return {
    width,
    height,
    cells,
    floor,
    floorMask,
    cuts: shape.cuts,
    room,
    arrival,
    exit,
    furnitureSlots: keepWalkable(shuffle(rng, againstWall), isFloor, arrival),
  };
}

export interface ReservedInteriorSlots {
  /** Where a shopkeeper should stand, or null if none was asked for. */
  shop: Slot | null;
  /** Where the stairs to a second storey should stand, or null. */
  stairs: Slot | null;
  /** What is left for ordinary furniture, in the same order the plan gave them. */
  remaining: Slot[];
}

/**
 * Carve a shopkeeper's tile and a staircase's tile out of a room's furniture
 * slots, before the rest go to furniture.
 *
 * Safe for the same reason `furnish` taking any *prefix* of `furnitureSlots`
 * is safe: `keepWalkable` already proved every prefix keeps the room whole, so
 * reserving the first one or two costs nothing to re-check here — a shopkeeper
 * or a staircase blocks its tile exactly like a piece of furniture would, and
 * the guarantee does not care which one-tile thing is standing there.
 *
 * Returns null when the room has fewer wall-adjacent tiles than were asked
 * for, so the caller can refuse by name rather than silently place nothing.
 */
export function reserveInteriorSlots(
  furnitureSlots: Slot[],
  options: { shop: boolean; secondStorey: boolean }
): ReservedInteriorSlots | null {
  const wanted = (options.shop ? 1 : 0) + (options.secondStorey ? 1 : 0);
  if (furnitureSlots.length < wanted) return null;

  let i = 0;
  const shop = options.shop ? furnitureSlots[i++] : null;
  const stairs = options.secondStorey ? furnitureSlots[i++] : null;
  return { shop, stairs, remaining: furnitureSlots.slice(i) };
}

/**
 * Drop any slot that would cut the room in two.
 *
 * A rectangular room could not really be sealed by single-tile furniture along
 * its walls, so this never had to exist. A shaped one can: a wing three tiles
 * wide is legal, and two pieces facing each other across it leave one tile,
 * while a third closes it. The plan hands back slots the caller may take *any
 * prefix of*, so each is tested against everything kept before it — the check
 * is on the set, not on one piece at a time.
 *
 * Reachability is measured from {@link InteriorPlan.arrival}, the tile the
 * player lands on, rather than from any floor cell: a region walled off from
 * the way in is unreachable however well connected it is to itself.
 */
function keepWalkable(
  slots: Slot[],
  isFloor: (x: number, y: number) => boolean,
  arrival: Slot
): Slot[] {
  const kept: Slot[] = [];
  const blocked = new Set<string>();
  const key = (x: number, y: number): string => `${x},${y}`;

  // The floor's own cells, found by walking out from arrival with nothing
  // blocked — which is also the assertion that the unfurnished room is whole.
  const allFloor = flood(isFloor, arrival, new Set<string>());

  const openCount = (): number => {
    let total = 0;
    for (const slot of allFloor) if (!blocked.has(key(slot.x, slot.y))) total++;
    return total;
  };

  for (const slot of slots) {
    blocked.add(key(slot.x, slot.y));
    const reachable = flood(isFloor, arrival, blocked).length;
    if (reachable === openCount()) kept.push(slot);
    else blocked.delete(key(slot.x, slot.y));
  }
  return kept;
}

function flood(
  isFloor: (x: number, y: number) => boolean,
  from: Slot,
  blocked: Set<string>
): Slot[] {
  const key = (x: number, y: number): string => `${x},${y}`;
  const seen = new Set<string>();
  const out: Slot[] = [];
  const queue: Slot[] = [];

  // The arrival tile is the doorway channel, which is floor but sits outside
  // the room's own mask; start from the tile above it when it is not itself in
  // the mask, so the walk begins inside the room either way.
  const start = isFloor(from.x, from.y) ? from : { x: from.x, y: from.y - 1 };
  if (!isFloor(start.x, start.y) || blocked.has(key(start.x, start.y))) return out;
  queue.push(start);
  seen.add(key(start.x, start.y));

  while (queue.length > 0) {
    const cell = queue.pop()!;
    out.push(cell);
    for (const [nx, ny] of [
      [cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1],
    ] as [number, number][]) {
      if (!isFloor(nx, ny) || seen.has(key(nx, ny)) || blocked.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      queue.push({ x: nx, y: ny });
    }
  }
  return out;
}

/** The plan as text: `#` wall top, `%` wall face, `.` floor, ` ` void. */
export function renderInteriorAscii(plan: InteriorPlan): string {
  const glyph: Record<Cell, string> = { void: ' ', wallTop: '#', wallFace: '%', floor: '.' };
  const rows = plan.cells.map((row) => row.map((c) => glyph[c]).join(''));
  rows[plan.exit.y] =
    rows[plan.exit.y].slice(0, plan.exit.x) + 'E' + rows[plan.exit.y].slice(plan.exit.x + 1);
  return rows.join('\n');
}

// --- the exit event ---------------------------------------------------------

export interface ExitTarget {
  mapId: number;
  x: number;
  y: number;
}

/**
 * The page the sample maps use for a way out: invisible, triggered by walking
 * onto it, drawn below characters so it never blocks the tile.
 *
 * This is `transferEventPage` — a way out of a house and a flight of stairs are
 * the same event, and measuring the two separately produced the identical page
 * (144 of 147 sample exit events; 157 of 157 stair pages). It lives in
 * `stairs.ts` rather than being written twice.
 *
 * Landing the player on this event does **not** re-trigger it: the engine only
 * checks player-touch events in `updateNonmoving` when `wasMoving` is true, and
 * `performTransfer` sets the position with `locate()` rather than by moving. So
 * a door on the outside can put the player straight onto the tile they will
 * later step off to leave, which is what makes the doorway read as a doorway.
 */
export function exitEventPage(target: ExitTarget, se = STAIR_SE): EventPage {
  return transferEventPage(target, { se });
}

export function exitEvent(id: number, x: number, y: number, target: ExitTarget): Event {
  return { id, name: `Exit${id}`, note: '', pages: [exitEventPage(target)], x, y };
}
