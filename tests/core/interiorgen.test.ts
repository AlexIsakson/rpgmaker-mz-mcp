import { describe, it, expect } from 'vitest';
import {
  planInterior,
  renderInteriorAscii,
  exitEventPage,
  exitEvent,
  InteriorError,
  VOID_TILE,
  WALL_FACE_ROWS,
  type InteriorOptions,
  type InteriorPlan,
} from '../../src/core/interiorgen.js';
import {
  doorEventPage,
  setDoorDestination,
  isDoorEvent,
  isDoorPage,
  doorEvent,
} from '../../src/core/blueprint.js';

function options(over: Partial<InteriorOptions> = {}): InteriorOptions {
  return { floorWidth: 7, floorHeight: 5, margin: 1, doorOffsetX: null, seed: 1, ...over };
}

const cellAt = (plan: InteriorPlan, x: number, y: number) => plan.cells[y][x];

/** Flood the walkable cells from a start point. */
function reachable(plan: InteriorPlan, from: { x: number; y: number }): Set<string> {
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const stack = [from];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= plan.width || ny >= plan.height) continue;
      if (cellAt(plan, nx, ny) !== 'floor' || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe('planInterior', () => {
  it('sizes the map from the floor plus the walls around it', () => {
    const plan = planInterior(options({ floorWidth: 7, floorHeight: 5, margin: 1 }));
    // width  = floor + a wall each side + margin each side
    // height = top ring + top face + floor + bottom ring + bottom face + margins
    expect(plan.width).toBe(7 + 2 + 2);
    expect(plan.height).toBe(1 + WALL_FACE_ROWS + 5 + 1 + WALL_FACE_ROWS + 2);
    expect(plan.floor).toEqual({ x: 2, y: 4, width: 7, height: 5 });
  });

  it('lays the room out the way the sample interiors do', () => {
    const plan = planInterior(options());
    const { x: rx, y: ry, width: rw } = plan.room;

    // a ring of wall top around the room
    expect(cellAt(plan, rx, ry)).toBe('wallTop');
    expect(cellAt(plan, rx + rw - 1, ry)).toBe('wallTop');
    expect(cellAt(plan, rx, plan.floor.y)).toBe('wallTop');
    expect(cellAt(plan, rx + rw - 1, plan.floor.y)).toBe('wallTop');

    // two rows of wall face beneath the back wall, inset by the side walls
    for (let i = 0; i < WALL_FACE_ROWS; i++) {
      expect(cellAt(plan, rx + 1, ry + 1 + i)).toBe('wallFace');
      expect(cellAt(plan, rx, ry + 1 + i)).toBe('wallTop');
    }

    // floor inside
    expect(cellAt(plan, plan.floor.x, plan.floor.y)).toBe('floor');

    // the front wall: a ring row then two more rows of face, full width
    const bottomRing = plan.floor.y + plan.floor.height;
    expect(cellAt(plan, rx, bottomRing)).toBe('wallTop');
    expect(cellAt(plan, rx, bottomRing + 1)).toBe('wallFace');
    expect(cellAt(plan, rx + rw - 1, bottomRing + WALL_FACE_ROWS)).toBe('wallFace');
  });

  it('fills everything outside the room with void', () => {
    const plan = planInterior(options({ margin: 2 }));
    expect(cellAt(plan, 0, 0)).toBe('void');
    expect(cellAt(plan, plan.width - 1, plan.height - 1)).toBe('void');
    expect(VOID_TILE).toBe(1536); // A5 tile 0, what the sample maps use
  });

  it('cuts the doorway straight down through the front wall', () => {
    const plan = planInterior(options());
    const bottomRing = plan.floor.y + plan.floor.height;
    for (let y = bottomRing; y < plan.room.y + plan.room.height; y++) {
      expect(cellAt(plan, plan.arrival.x, y), `row ${y}`).toBe('floor');
    }
    expect(plan.arrival.y).toBe(bottomRing);
    expect(plan.exit.y).toBe(plan.room.y + plan.room.height - 1);
    expect(plan.exit.x).toBe(plan.arrival.x);
  });

  it('centres the doorway by default and honours an offset', () => {
    expect(planInterior(options({ floorWidth: 7 })).arrival.x).toBe(2 + 3);
    expect(planInterior(options({ floorWidth: 7, doorOffsetX: 0 })).arrival.x).toBe(2);
    expect(planInterior(options({ floorWidth: 7, doorOffsetX: 6 })).arrival.x).toBe(2 + 6);
  });

  it('leaves every floor tile reachable from the doorway', () => {
    // The property that matters: a room you cannot walk into is not a room.
    for (let seed = 1; seed <= 10; seed++) {
      for (const [fw, fh] of [[3, 2], [5, 4], [7, 5], [12, 9]] as const) {
        const plan = planInterior(options({ floorWidth: fw, floorHeight: fh, seed }));
        const floorCells = plan.cells.flatMap((row, y) =>
          row.map((c, x) => (c === 'floor' ? `${x},${y}` : null)).filter(Boolean)
        );
        expect(reachable(plan, plan.exit).size, `${fw}x${fh}`).toBe(floorCells.length);
      }
    }
  });

  it('keeps furniture off the doorway column and against a wall', () => {
    // Furniture is impassable, so anything in the doorway column seals the room.
    for (let seed = 1; seed <= 10; seed++) {
      const plan = planInterior(options({ seed }));
      expect(plan.furnitureSlots.length).toBeGreaterThan(0);
      for (const slot of plan.furnitureSlots) {
        expect(slot.x, `seed ${seed}`).not.toBe(plan.arrival.x);
        expect(cellAt(plan, slot.x, slot.y)).toBe('floor');
        const onEdge =
          slot.x === plan.floor.x ||
          slot.x === plan.floor.x + plan.floor.width - 1 ||
          slot.y === plan.floor.y ||
          slot.y === plan.floor.y + plan.floor.height - 1;
        expect(onEdge).toBe(true);
      }
    }
  });

  it('offers the same slots in the same order for a given seed', () => {
    expect(planInterior(options({ seed: 4 }))).toEqual(planInterior(options({ seed: 4 })));
    expect(planInterior(options({ seed: 4 })).furnitureSlots)
      .not.toEqual(planInterior(options({ seed: 5 })).furnitureSlots);
  });

  it('refuses a floor too small to hold a doorway with wall either side', () => {
    expect(() => planInterior(options({ floorWidth: 2 }))).toThrow(InteriorError);
    expect(() => planInterior(options({ floorHeight: 1 }))).toThrow(/at least a 3x2/);
  });

  it('refuses a doorway outside the floor', () => {
    expect(() => planInterior(options({ floorWidth: 5, doorOffsetX: 5 }))).toThrow(/outside a 5-wide/);
  });
});

describe('renderInteriorAscii', () => {
  it('draws the room at map size and marks the exit', () => {
    const plan = planInterior(options());
    const rows = renderInteriorAscii(plan).split('\n');
    expect(rows).toHaveLength(plan.height);
    expect(rows[0]).toHaveLength(plan.width);
    expect(rows[plan.exit.y][plan.exit.x]).toBe('E');
  });
});

describe('exitEventPage', () => {
  it('matches the sample maps: invisible, player touch, below characters', () => {
    const page = exitEventPage({ mapId: 2, x: 6, y: 23 });
    expect(page.image.characterName).toBe('');
    expect(page.trigger).toBe(1);        // player touch
    expect(page.priorityType).toBe(0);   // below characters, so it blocks nothing
    expect(page.through).toBe(false);
    expect(page.list.map((c) => c.code)).toEqual([250, 201, 0]);
  });

  it('carries the destination', () => {
    const transfer = exitEventPage({ mapId: 9, x: 4, y: 11 }).list.find((c) => c.code === 201)!;
    // [designation, mapId, x, y, direction (0 = retain), fade (0 = black)]
    expect(transfer.parameters).toEqual([0, 9, 4, 11, 0, 0]);
  });

  it('places one page at the given tile', () => {
    const event = exitEvent(2, 5, 11, { mapId: 1, x: 1, y: 1 });
    expect(event).toMatchObject({ id: 2, x: 5, y: 11 });
    expect(event.pages).toHaveLength(1);
  });
});

describe('setDoorDestination', () => {
  it('fills in the transfer a door built without one is missing', () => {
    const page = doorEventPage();
    expect(page.list.map((c) => c.code)).not.toContain(201);

    const had = setDoorDestination(page, { mapId: 5, x: 4, y: 8 });
    expect(had).toBe(false);

    const codes = page.list.map((c) => c.code);
    expect(codes).toContain(201);
    // and it must land before the end marker, or the engine never reaches it
    expect(codes.indexOf(201)).toBeLessThan(codes.indexOf(0));
    expect(codes[codes.length - 1]).toBe(0);
  });

  it('retargets a door that already leads somewhere, without duplicating it', () => {
    const page = doorEventPage({ target: { mapId: 2, x: 1, y: 1 } });
    const before = page.list.length;

    const had = setDoorDestination(page, { mapId: 7, x: 3, y: 9 });
    expect(had).toBe(true);
    expect(page.list.length).toBe(before);
    expect(page.list.filter((c) => c.code === 201)).toHaveLength(1);
    expect(page.list.find((c) => c.code === 201)!.parameters).toEqual([0, 7, 3, 9, 0, 0]);
  });

  it('leaves the door animation intact either way', () => {
    const page = doorEventPage();
    setDoorDestination(page, { mapId: 5, x: 4, y: 8 });
    // the two Set Movement Routes and their mirrored 505 lines still run first
    expect(page.list.filter((c) => c.code === 205)).toHaveLength(2);
    expect(page.list.filter((c) => c.code === 505)).toHaveLength(7);
    expect(page.list[0].code).toBe(250);
  });
});

describe('recognising doors', () => {
  it('knows a door by its sprite', () => {
    expect(isDoorPage(doorEventPage())).toBe(true);
    expect(isDoorPage(doorEventPage({ characterName: '!Door2' }))).toBe(true);
    expect(isDoorPage(exitEventPage({ mapId: 1, x: 1, y: 1 }))).toBe(false);
    expect(isDoorPage(doorEventPage({ characterName: 'Actor1' }))).toBe(false);
  });

  it('knows a door event by any of its pages', () => {
    expect(isDoorEvent(doorEvent(1, 3, 4))).toBe(true);
    expect(isDoorEvent(exitEvent(1, 3, 4, { mapId: 1, x: 1, y: 1 }))).toBe(false);
  });
});

describe('a door and its room together', () => {
  it('sends the player in at the doorway and back out in front of the door', () => {
    // The round trip is the whole point, and it is easy to get backwards: the
    // door lands you on the room's doorway tile, and the room's exit lands you
    // on the tile in front of the door — not on the door itself, which would
    // put the player inside a wall.
    const doorX = 12;
    const doorY = 9;
    const plan = planInterior(options());
    const interiorMapId = 20;
    const townMapId = 3;

    const door = doorEvent(1, doorX, doorY);
    setDoorDestination(door.pages[0], {
      mapId: interiorMapId,
      x: plan.arrival.x,
      y: plan.arrival.y,
    });
    const way = exitEvent(1, plan.exit.x, plan.exit.y, {
      mapId: townMapId,
      x: doorX,
      y: doorY + 1,
    });

    const inbound = door.pages[0].list.find((c) => c.code === 201)!.parameters;
    const outbound = way.pages[0].list.find((c) => c.code === 201)!.parameters;

    expect(inbound).toEqual([0, interiorMapId, plan.arrival.x, plan.arrival.y, 0, 0]);
    expect(outbound).toEqual([0, townMapId, doorX, doorY + 1, 0, 0]);

    // arriving inside puts the player on floor, and on the exit's own column
    expect(cellAt(plan, plan.arrival.x, plan.arrival.y)).toBe('floor');
    expect(plan.arrival.x).toBe(way.x);
    // and the way out is below the way in, so leaving means walking back down
    expect(way.y).toBeGreaterThan(plan.arrival.y);
  });
});
