import { makeRng } from './mapgen.js';
import { TILE_ID_A5, type Rect } from './autotile.js';
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
}

export interface Slot {
  x: number;
  y: number;
}

export interface InteriorPlan {
  width: number;
  height: number;
  /** `cells[y][x]` — what belongs on the ground layer. */
  cells: Cell[][];
  /** The walkable floor, not counting the doorway channel. */
  floor: Rect;
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

export function planInterior(options: InteriorOptions): InteriorPlan {
  const { floorWidth, floorHeight, margin, seed } = options;

  if (floorWidth < 3 || floorHeight < 2) {
    throw new InteriorError(
      `A room needs at least a 3x2 floor; ${floorWidth}x${floorHeight} was asked for. Narrower ` +
        'than three leaves no wall either side of the doorway.'
    );
  }
  if (margin < 0) throw new InteriorError('margin cannot be negative.');

  const doorOffsetX = options.doorOffsetX ?? Math.floor(floorWidth / 2);
  if (doorOffsetX < 0 || doorOffsetX >= floorWidth) {
    throw new InteriorError(
      `Doorway offset ${doorOffsetX} is outside a ${floorWidth}-wide floor.`
    );
  }

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

  const cells: Cell[][] = Array.from({ length: height }, () => new Array<Cell>(width).fill('void'));

  const bottomRingY = floor.y + floor.height;

  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      const onSide = x === room.x || x === room.x + room.width - 1;

      if (y === room.y || y === bottomRingY) {
        cells[y][x] = 'wallTop';
      } else if (y < floor.y) {
        // the inside of the back wall, inset by the side walls
        cells[y][x] = onSide ? 'wallTop' : 'wallFace';
      } else if (y < bottomRingY) {
        cells[y][x] = onSide ? 'wallTop' : 'floor';
      } else {
        // the outside of the front wall, drawn full width beneath the ring
        cells[y][x] = 'wallFace';
      }
    }
  }

  // The doorway is a channel straight down through the front wall.
  const doorX = floor.x + doorOffsetX;
  for (let y = bottomRingY; y < room.y + room.height; y++) cells[y][doorX] = 'floor';

  const arrival: Slot = { x: doorX, y: bottomRingY };
  const exit: Slot = { x: doorX, y: room.y + room.height - 1 };

  // Furniture goes against a wall, and never in the doorway column — that
  // column is the only way in and out, so anything standing in it seals the
  // room. Blocked entrances were exactly what the placement audit was written
  // to catch, so the generator does not create them in the first place.
  const againstWall: Slot[] = [];
  for (let y = floor.y; y < floor.y + floor.height; y++) {
    for (let x = floor.x; x < floor.x + floor.width; x++) {
      if (x === doorX) continue;
      const touchesWall =
        x === floor.x ||
        x === floor.x + floor.width - 1 ||
        y === floor.y ||
        y === floor.y + floor.height - 1;
      if (touchesWall) againstWall.push({ x, y });
    }
  }

  return {
    width,
    height,
    cells,
    floor,
    room,
    arrival,
    exit,
    furnitureSlots: shuffle(makeRng(seed), againstWall),
  };
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
