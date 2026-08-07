import { readLayer, writeLayer, hasTileBelow } from './map-layers.js';
import { fillWallRect } from './wall-autotile.js';
import { loadTransparentObjectTiles } from './tileset-image.js';
import {
  planBuilding,
  doorEvent,
  findRoofSet,
  pairedWallKind,
  nineSliceFits,
  BlueprintError,
  OUTSIDE_C_SHEET_NAME,
  type BuildingPlan,
  type DoorTarget,
  type RoofPlan,
} from './blueprint.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';

/**
 * Writing a planned building into a map: walls on the ground layer, roof on its
 * own, a door event, and the checks that stand between a caller and a building
 * with black wedges cut out of it.
 *
 * `planBuilding` decides what a building is made of; this decides where it
 * lands. Both `place_building` and the town generator go through here, so a
 * house is assembled the same way whether one was asked for or forty were.
 */

/** Set number 6 of a tileset's names is the C sheet — see Tilemap._drawNormalTile. */
const C_SHEET_INDEX = 6;

export class BuildingPlacementError extends Error {}

export interface BuildingContext {
  projectPath: string;
  tilesetNames: string[];
  tilesetName: string;
}

export interface BuildingRequest {
  x: number;
  y: number;
  width: number;
  height: number;
  wallHeight: number;
  wallKind?: number;
  /** One of these three picks the roof. */
  roofSet?: string;
  roofTopLeftTileId?: number;
  roofKind?: number;
  roofLayer: number;
  door: boolean;
  doorOffsetX?: number;
  doorSprite: string;
  doorSpriteIndex: number;
  doorTarget?: DoorTarget;
  allowRoofOverEmptyGround: boolean;
}

export interface BuildingPlacementResult {
  plan: BuildingPlan;
  roof: RoofPlan;
  wallKind: number;
  doorEventId: number | null;
  notes: string[];
}

/** Append an event, reusing the first free slot the way the editor does. */
export function addEvent(mapData: MapData, make: (id: number) => Event): Event {
  let slot = mapData.events.findIndex((e, i) => i > 0 && e === null);
  if (slot === -1) slot = Math.max(mapData.events.length, 1);

  while (mapData.events.length <= slot) mapData.events.push(null);
  const event = make(slot);
  mapData.events[slot] = event;
  return event;
}

function resolveRoof(
  request: BuildingRequest,
  ctx: BuildingContext
): { roof: RoofPlan; sheetName?: string } {
  const given = [request.roofSet, request.roofTopLeftTileId, request.roofKind].filter(
    (v) => v !== undefined
  );
  if (given.length !== 1) {
    throw new BuildingPlacementError(
      'Give exactly one of roofSet, roofTopLeftTileId or roofKind.'
    );
  }

  if (request.roofKind !== undefined) {
    return { roof: { style: 'autotile', kind: request.roofKind } };
  }

  if (request.roofSet !== undefined) {
    const cSheet = ctx.tilesetNames[C_SHEET_INDEX];
    if (cSheet !== OUTSIDE_C_SHEET_NAME) {
      throw new BuildingPlacementError(
        `roofSet names a set on ${OUTSIDE_C_SHEET_NAME}, but tileset "${ctx.tilesetName}" uses ` +
          `"${cSheet || '(none)'}" as its C sheet. Object sheets have no shared layout, so a set ` +
          'from one is meaningless on another — pass roofTopLeftTileId with the top-left tile of ' +
          'a roof block you have located on this tileset, or use roofKind for a flat A3 roof.'
      );
    }
    const set = findRoofSet(request.roofSet);
    if (!set) throw new BuildingPlacementError(`Unknown roof set "${request.roofSet}".`);
    return { roof: { style: 'nineslice', topLeft: set.topLeft }, sheetName: cSheet };
  }

  const topLeft = request.roofTopLeftTileId!;
  if (!nineSliceFits(topLeft)) {
    throw new BuildingPlacementError(
      `Tile ${topLeft} cannot start a 3x3 block — it sits too close to the edge of its half of ` +
        'the sheet, so the block would wrap around. The object sheets are 16 tiles wide but ' +
        'addressed as two 8-wide halves.'
    );
  }
  return {
    roof: { style: 'nineslice', topLeft },
    sheetName: ctx.tilesetNames[5 + Math.floor(topLeft / 256)],
  };
}

/**
 * Place one building. Mutates `mapData`; the caller writes the file.
 *
 * Throws {@link BuildingPlacementError} with a message meant for the caller
 * rather than for a log — every refusal here is something they can fix.
 */
export async function placeBuildingOnMap(
  mapData: MapData,
  request: BuildingRequest,
  ctx: BuildingContext
): Promise<BuildingPlacementResult> {
  const { x, y, width, height, roofLayer } = request;

  if (x + width > mapData.width || y + height > mapData.height) {
    throw new BuildingPlacementError(
      `The footprint runs off the map (map is ${mapData.width}x${mapData.height}, footprint is ` +
        `${width}x${height} at (${x}, ${y})). A clipped building loses its edge pieces, so this ` +
        'is refused rather than trimmed.'
    );
  }

  const { roof, sheetName } = resolveRoof(request, ctx);

  const wallKind =
    request.wallKind ??
    (request.roofKind !== undefined ? pairedWallKind(request.roofKind) : undefined);
  if (wallKind === undefined) {
    throw new BuildingPlacementError(
      'wallKind is required with a nine-slice roof: the C-sheet sets are roof art only and carry ' +
        'no wall to stand on. A3 wall kinds are 56-63 and 72-79.'
    );
  }

  let plan: BuildingPlan;
  try {
    plan = planBuilding({
      x, y, width, height,
      wallHeight: request.wallHeight,
      wallKind,
      roof,
      doorOffsetX: request.door ? (request.doorOffsetX ?? Math.floor(width / 2)) : null,
    });
  } catch (error) {
    if (error instanceof BlueprintError) throw new BuildingPlacementError(error.message);
    throw error;
  }

  const notes = [...plan.warnings];

  // Walls go on the ground layer, where they are opaque by construction.
  let ground = readLayer(mapData, 0);
  ground = fillWallRect(ground, plan.wallRect, plan.wallTileId);

  if (plan.roofTiles) {
    // A nine-slice roof's sloped corners are cut away and show whatever is
    // beneath them, so they need ground under them and cannot go on layer 0.
    // Only the cells that are actually cut matter, so measure the sheet.
    const uniqueRoofTiles = [...new Set(plan.roofTiles.flat())];
    const cut = sheetName
      ? await loadTransparentObjectTiles(ctx.projectPath, sheetName, uniqueRoofTiles)
      : null;

    // The walls are painted above but not yet written back; they occupy rows
    // disjoint from the roof, and a shape refresh never turns an empty cell into
    // a full one, so reading mapData here is equivalent.
    const bare: string[] = [];
    for (let j = 0; j < plan.roofRect.height; j++) {
      for (let i = 0; i < plan.roofRect.width; i++) {
        const tileId = plan.roofTiles[j][i];
        if (cut && !cut.has(tileId)) continue;
        const gx = plan.roofRect.x + i;
        const gy = plan.roofRect.y + j;
        if (!hasTileBelow(mapData, gx, gy, roofLayer)) bare.push(`(${gx}, ${gy})`);
      }
    }

    if (bare.length > 0 && !request.allowRoofOverEmptyGround) {
      throw new BuildingPlacementError(
        `${bare.length} roof tile(s) are cut away at the corners and have nothing painted under ` +
          `them: ${bare.slice(0, 8).join(' ')}${bare.length > 8 ? ' ...' : ''}\n\n` +
          'Those cut corners show the layer below, and with nothing there they render as the map ' +
          'background — black in game. Fill the ground under the footprint first ' +
          '(fill_map_region on layer 0), or pass allowRoofOverEmptyGround if the holes are ' +
          'deliberate.'
      );
    }
    if (cut === null) {
      notes.push(
        `Could not read img/tilesets/${sheetName}.png, so the roof's cut-away corners were not ` +
          'checked against what is beneath them. If the roof shows black wedges in game, that is why.'
      );
    }

    const roofGrid = readLayer(mapData, roofLayer);
    let overwritten = 0;
    for (let j = 0; j < plan.roofRect.height; j++) {
      for (let i = 0; i < plan.roofRect.width; i++) {
        const gx = plan.roofRect.x + i;
        const gy = plan.roofRect.y + j;
        if (roofGrid[gy][gx] !== 0) overwritten++;
        roofGrid[gy][gx] = plan.roofTiles[j][i];
      }
    }
    writeLayer(mapData, roofLayer, roofGrid);
    if (overwritten > 0) {
      notes.push(`Overwrote ${overwritten} tile(s) already on layer ${roofLayer} under the roof.`);
    }
  } else {
    ground = fillWallRect(ground, plan.roofRect, plan.roofTileId!);
  }

  writeLayer(mapData, 0, ground);

  let doorEventId: number | null = null;
  if (plan.door) {
    const placed = addEvent(mapData, (id) =>
      doorEvent(id, plan.door!.x, plan.door!.y, {
        characterName: request.doorSprite,
        characterIndex: request.doorSpriteIndex,
        target: request.doorTarget,
      })
    );
    doorEventId = placed.id;

    if (!request.doorTarget) {
      notes.push(
        `Door event ${doorEventId} opens but leads nowhere — no destination was given. Add a ` +
          'Transfer Player command to it once the interior map exists.'
      );
    }
    if (plan.door.approach.y >= mapData.height) {
      notes.push(
        'The door is on the bottom row of the map, so there is no tile in front of it for the ' +
          'player to stand on. It cannot be reached.'
      );
    }
  }

  return { plan, roof, wallKind, doorEventId, notes };
}
