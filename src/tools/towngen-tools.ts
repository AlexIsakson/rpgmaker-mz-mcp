import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import { fillRect, makeAutotileId, getAutotileKind, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { applyWallShadows } from '../core/shadows.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials } from '../core/tileset-image.js';
import { checkGroundKinds } from '../core/ground-material.js';
import { checkSheetsPresent } from '../core/tileset-sheets.js';
import { placeBuildingOnMap, addEvent, BuildingPlacementError } from '../core/building-placement.js';
import {
  planTown,
  renderTownAscii,
  assessTownBuild,
  planTownPeople,
  planTownShop,
  TownError,
  TOWN_DEFAULTS,
} from '../core/towngen.js';
import {
  npcEvent,
  planNpcPlacement,
  charactersOnSheet,
  MOVE_TYPES,
  DEFAULT_NPC_SHEETS,
  DEFAULT_NPC_DIALOGUE,
  type MoveType,
} from '../core/npcgen.js';
import { standableGrid, canPass, type Direction } from '../core/walkability.js';
import { censusMap, clearMap, describeKeptContent } from '../core/map-reset.js';
import { listCharacterSheets } from './npc-tools.js';
import { loadPresetStock, SHOP_GREETINGS } from './shop-tools.js';
import { shopCommands, describeGoods } from '../core/shop.js';
import { ROOF_SET_NAMES, A3_KIND_MIN, A4_KIND_MAX } from '../core/blueprint.js';
import { collectProps, findProps, propCells, propPart, PropError, type Prop } from '../core/props.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { MapRefError } from '../core/map-refs.js';
import { requireProjectSheets } from './map-ref-loaders.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;

/**
 * Defaults tuned for the RTP outdoor tilesets. Any name that does not resolve
 * against the map's own tileset is skipped and reported rather than failing the
 * run, so a different tileset degrades to fewer props instead of no town.
 */
const DEFAULT_DECOR = ['Barrel', 'Crate A', 'Pot', 'Firewood', 'Flowers A', 'Flowers B', 'Bush', 'Stump'];
const DEFAULT_FRAME = 'Tree';

/** The door sheet every generated building uses. RTP, and in every project on hand. */
const TOWN_DOOR_SPRITE = '!Door1';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Resolve a prop name to something the given footprint can hold, narrowing to
 * the top-left corner when the name bundles filler variants — the `Tree` case,
 * where stamping the whole group leaves a canopy square beside the trunk.
 */
function resolveFramingProp(props: Prop[], name: string, height: number): Prop | null {
  const found = findProps(props, name);
  if (found.length === 0) return null;
  const prop = found[0];
  try {
    return propPart(prop, {
      x: 0,
      y: 0,
      width: 1,
      height: Math.min(height, prop.height),
    });
  } catch (error) {
    if (error instanceof PropError) return null;
    throw error;
  }
}

export function registerTowngenTools(server: McpServer): void {
  server.tool(
    'generate_town',
    'Generate a whole town onto a map: ground, streets, rows of buildings with ' +
      'working door events, a tree line framing the edge, and a decoration pass. ' +
      'Buildings sit in bands facing the street below them, because a door is on ' +
      'a building\'s bottom row and is entered from the tile beneath it. Streets ' +
      'run to the map edge so the town has ways in, and cross streets guarantee ' +
      'the network is connected. Same seed, same town. The map is replaced — its ' +
      'existing tiles and events both go.',
    {
      mapId: z.number().int().positive()
        .describe('Map ID. Its tiles and its events are both replaced.'),
      seed: z.number().int().default(1).describe('Layout seed; the same seed reproduces the town'),
      groundKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).default(A2_KIND_MIN)
        .describe(
          'A2 material for the ground. Must be an opaque *ground* material — it covers the ' +
          'whole of layer 0, so an overlay renders black everywhere. A seamless fill suits it ' +
          'best, since there is no edge for an outline to draw. describe_tileset_materials ' +
          'says which kinds are which for this tileset.'
        ),
      roadKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).optional()
        .describe(
          'A2 material for the streets. Wants an outlined material so the road reads as a road ' +
          'against the ground. Omit to leave the streets as bare ground.'
        ),
      allowOverlayOnGround: z.boolean().default(false)
        .describe(
          'Lay an overlay A2 material as the ground or the streets anyway. Refused by default ' +
          'because its transparent edges render as black.'
        ),
      roofSets: z.array(z.enum(ROOF_SET_NAMES as [string, ...string[]])).optional()
        .describe(
          `Nine-slice roof sets to vary the buildings with (${ROOF_SET_NAMES.join(', ')}). ` +
          'Only valid on a tileset whose C sheet is Outside_C. Defaults to all of them there; ' +
          'on any other tileset pass roofKinds instead.'
        ),
      roofKinds: z.array(z.number().int().min(A3_KIND_MIN).max(A4_KIND_MAX)).optional()
        .describe(
          'A3 roof materials to vary the buildings with, as an alternative to roofSets. Each ' +
          'brings its own wall (the kind 8 below it). A3 roofs are flat texture with no edge ' +
          'art, so they read as slabs.'
        ),
      wallKind: z.number().int().min(A3_KIND_MIN).max(A4_KIND_MAX).optional()
        .describe('Wall material for nine-slice-roofed buildings. Required with roofSets.'),
      border: z.number().int().min(0).default(TOWN_DEFAULTS.border)
        .describe('Tiles reserved around the map edge for the tree line'),
      roadWidth: z.number().int().min(1).max(4).default(TOWN_DEFAULTS.roadWidth)
        .describe('Street thickness in tiles'),
      bandHeight: z.number().int().min(4).default(TOWN_DEFAULTS.bandHeight)
        .describe(
          'Height of a row of buildings plus the gap above it. With bothSidesOfStreet on, a ' +
          'band this tall holds two rows back to back once floor((bandHeight - 1) / 2) is at ' +
          'least the shortest legal building.'
        ),
      bothSidesOfStreet: z.boolean().default(TOWN_DEFAULTS.bothSidesOfStreet)
        .describe(
          'Build a north-facing row of buildings along the top of every band that has a road ' +
          'above it, so a street is built up on both sides instead of only below. Needs a band ' +
          'tall enough for two buildings back to back; on a shorter band it does nothing, and ' +
          'says so. Off by default because of how it looks, not what it does: a north-facing ' +
          'building has to put its wall band above its roof, and the RTP roof sets are ' +
          'directional art, so the wall renders as though it were standing on the roof. Of the ' +
          '107 door events in the 293 sample maps, the 88 with an unambiguous approach are ' +
          'entered from below in 88 of 88 — nothing shipped is entered from the north. The ' +
          'layout itself is sound: a 44x46 town goes from 8 buildings to 12, every door reaches ' +
          'a street, and walkability stays one connected area.'
        ),
      crossStreets: z.number().int().min(1).max(4).default(TOWN_DEFAULTS.crossStreets)
        .describe('Vertical streets. At least one, or the horizontal roads never meet.'),
      minBuildingWidth: z.number().int().min(2).default(TOWN_DEFAULTS.minBuildingWidth),
      maxBuildingWidth: z.number().int().min(2).default(TOWN_DEFAULTS.maxBuildingWidth),
      minBuildingHeight: z.number().int().min(3).default(TOWN_DEFAULTS.minBuildingHeight),
      maxBuildingHeight: z.number().int().min(3).default(TOWN_DEFAULTS.maxBuildingHeight),
      wallHeight: z.number().int().min(1).default(TOWN_DEFAULTS.wallHeight)
        .describe('Rows of wall at the bottom of each building; the rest is roof'),
      decorDensity: z.number().min(0).max(1).default(TOWN_DEFAULTS.decorDensity)
        .describe('Fraction of the free ground that gets a prop'),
      decorProps: z.array(z.string()).optional()
        .describe(
          `Prop names to scatter. Defaults to ${DEFAULT_DECOR.join(', ')} — names that do not ` +
          'exist in this tileset are skipped and reported.'
        ),
      frameProp: z.string().default(DEFAULT_FRAME)
        .describe(
          'Prop for the tree line around the edge. Its top-left column is used, so a name that ' +
          'bundles filler variants still gives a single tree. Empty string leaves the edge bare.'
        ),
      npcCount: z.number().int().min(0).max(100).default(6)
        .describe(
          'Townspeople to place, on the streets and the open ground between buildings. 0 leaves ' +
          'the town empty. This is a flat count, not a density: across the 26 populated maps of ' +
          'the largest project on hand, NPC count and map area correlate at r = 0.09 — the two ' +
          'most crowded maps are the smallest — so a bigger town does not want more people ' +
          'unless you say so. Nobody is placed on a door approach tile or anywhere that standing ' +
          'would seal part of the town off.'
        ),
      npcSheets: z.array(z.string()).optional()
        .describe(
          `Sprite sheets for the townspeople. Defaults to ${DEFAULT_NPC_SHEETS.join(', ')}; any ` +
          'the project does not have are skipped and reported.'
        ),
      npcDialogue: z.array(z.string()).optional()
        .describe(
          'Lines to give them, cycled. The built-in default is obvious placeholder text — pass ' +
          'your own for anything that matters.'
        ),
      npcMovement: z.enum(MOVE_TYPES as unknown as [string, ...string[]]).default('fixed')
        .describe(
          'fixed stands still, random wanders. Fixed is what 52 of 63 measured NPCs use. A ' +
          'wanderer can walk into a doorway at runtime, which no static check can see.'
        ),
      npcNamePrefix: z.string().default('Villager').describe('Event names, numbered from 1'),
      shop: z.boolean().default(true)
        .describe(
          'Give the town a working shop, stocked from the project database. The keeper stands ' +
          'beside the door of the building nearest the middle of the map — never on the door ' +
          'approach tile, which would block its own shop. Off leaves the town with no merchant.'
        ),
      shopPreset: z.enum(['general', 'weapon', 'armor']).default('general')
        .describe('What the shop deals in. Same presets as place_shop.'),
      shopStockCount: z.number().int().min(1).max(40).default(6)
        .describe('How many things the shop stocks'),
      shopPriceBand: z.array(z.number().min(0).max(1)).length(2).optional()
        .describe(
          'Slice of the price range to stock, as two fractions of the tradeable entries sorted ' +
          'by price. Defaults to [0, 0.5] — the cheaper half, which suits a town.'
        ),
      shopGreeting: z.string().optional()
        .describe('What the keeper says before the window opens. Omit for the preset line.'),
      keepExistingTiles: z.boolean().default(false)
        .describe(
          'Leave whatever is already painted on layers 1-3, the shadow plane and the region ' +
          'plane, instead of clearing the map first. Off by default: regenerating a town used ' +
          'to strand the roofs and props of the run before it — 139 cells of one 44x34 town ' +
          'survived into the next — and props are written only onto empty cells, so a stale one ' +
          'displaces the new one rather than merely sitting beside it. Turn it on to lay a town ' +
          'over terrain you painted by hand; the result then says what it kept.'
        ),
      roofLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(2)
        .describe('Layer for nine-slice roofs'),
      propLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for props and the tree line'),
    },
    async (args) => {
      try {
        const { mapId, seed, groundKind, roadKind, roofSets, roofKinds, wallKind, roofLayer, propLayer } = args;

        const project = requireProject();
        // generate_town hardcodes the RTP door sheet, so a project without it
        // would get a town whose every doorway crashes the map on arrival.
        await requireProjectSheets(project.path, [[TOWN_DOOR_SPRITE, 'the door sprite']]);
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const ctx = {
          projectPath: project.path,
          tilesetNames: tileset.tilesetNames,
          tilesetName: tileset.name,
        };

        // --- roofs ---
        if (roofSets && roofKinds) {
          return errorResult('Give roofSets or roofKinds, not both.');
        }
        let roofChoices: ({ roofSet: string } | { roofKind: number })[];
        if (roofKinds && roofKinds.length > 0) {
          roofChoices = roofKinds.map((kind) => ({ roofKind: kind }));
        } else if (roofSets && roofSets.length > 0) {
          roofChoices = roofSets.map((name) => ({ roofSet: name }));
        } else if (tileset.tilesetNames[6] === 'Outside_C') {
          roofChoices = ROOF_SET_NAMES.map((name) => ({ roofSet: name }));
        } else {
          return errorResult(
            `Tileset "${tileset.name}" uses "${tileset.tilesetNames[6] || '(none)'}" as its C ` +
            'sheet, so the built-in nine-slice roof sets do not apply to it. Pass roofKinds with ' +
            'A3 roof materials from this tileset, or use a tileset built on Outside_C.'
          );
        }
        // A tileset slot is allowed to be empty, and a kind pointing at an empty
        // one draws nothing at all. Four of the six shipped tilesets have no A3,
        // which is where roofKinds and wallKind live, so this catches a whole
        // town built out of invisible buildings before any of it is written.
        const sheetRefusal = checkSheetsPresent(
          [
            { kind: groundKind, label: 'groundKind' },
            { kind: roadKind, label: 'roadKind' },
            { kind: wallKind, label: 'wallKind' },
            ...(roofKinds ?? []).map((kind, i) => ({ kind, label: `roofKinds[${i}]` })),
          ],
          tileset.tilesetNames,
          tileset.name
        );
        if (sheetRefusal !== null) return errorResult(sheetRefusal);

        // The ground covers every tile of layer 0 and the streets run across it.
        // groundKind went unchecked until now, which made this the largest
        // unguarded overlay paint in the server — bigger than the fill_map_region
        // call the check was written for. Checked before the map is cleared.
        const groundCheck = checkGroundKinds(
          [
            { kind: groundKind, label: 'groundKind', layer: 0, coversMap: true },
            ...(roadKind === undefined
              ? []
              : [{ kind: roadKind, label: 'roadKind', layer: 0, coversMap: false }]),
          ],
          await loadA2Materials(project.path, tileset.tilesetNames),
          tileset.name,
          { allowOverlayOnGround: args.allowOverlayOnGround, reportUncheckable: true }
        );
        if (groundCheck.refusal !== null) return errorResult(groundCheck.refusal);

        const usingSets = 'roofSet' in roofChoices[0];
        if (usingSets && wallKind === undefined) {
          return errorResult(
            'wallKind is required with nine-slice roof sets: the C-sheet sets are roof art only ' +
            'and carry no wall to stand on. A3 wall kinds are 56-63 and 72-79.'
          );
        }

        // --- plan ---
        let plan;
        try {
          plan = planTown({
            width: mapData.width,
            height: mapData.height,
            seed,
            border: args.border,
            roadWidth: args.roadWidth,
            bandHeight: args.bandHeight,
            minBuildingWidth: args.minBuildingWidth,
            maxBuildingWidth: args.maxBuildingWidth,
            minBuildingHeight: args.minBuildingHeight,
            maxBuildingHeight: args.maxBuildingHeight,
            wallHeight: args.wallHeight,
            crossStreets: args.crossStreets,
            decorDensity: args.decorDensity,
            framePropHeight: TOWN_DEFAULTS.framePropHeight,
            bothSidesOfStreet: args.bothSidesOfStreet,
          });
        } catch (error) {
          if (error instanceof TownError) return errorResult(error.message);
          throw error;
        }

        const notes = [...plan.warnings];

        // Every tile is about to be rewritten, so the events have to go too.
        // Leaving them behind stacks a fresh set of door events on top of the
        // last run's — thirteen buildings, thirty-six doors, and every door but
        // the newest pointing at a building that is no longer there.
        //
        // The tiles used to be the exception: only layer 0 was refilled, so the
        // roofs and props of the previous run stayed. Regenerating a 44x34 town
        // at a new seed left 139 cells of the old one — and props are written
        // with skipOccupied, so a stale prop beat the new one rather than
        // merely surviving beside it. See src/core/map-reset.ts.
        const before = censusMap(mapData);
        const clearedEvents = before.events;
        let keptNote: string | null = null;

        if (args.keepExistingTiles) {
          mapData.events = [null];
          keptNote = describeKeptContent(censusMap(mapData, [0]));
        } else {
          clearMap(mapData, { events: true });
        }

        // --- ground and streets ---
        let ground = readLayer(mapData, 0);
        ground = fillRect(
          ground,
          { x: 0, y: 0, width: mapData.width, height: mapData.height },
          makeAutotileId(groundKind, 0),
          { region: { x: 0, y: 0, width: mapData.width, height: mapData.height } }
        );
        if (roadKind !== undefined) {
          for (const road of plan.roads) ground = fillRect(ground, road, makeAutotileId(roadKind, 0));
        }
        writeLayer(mapData, 0, ground);

        // The overlay half of this used to be a note here; it is now a refusal
        // made before anything was written. What is left is the advice: a
        // seamless street has no edge against the ground and does not read as a
        // street.
        notes.push(...groundCheck.notes);

        // --- buildings ---
        let placed = 0;
        let doors = 0;
        const failures: string[] = [];
        for (const building of plan.buildings) {
          const choice = roofChoices[building.variant % roofChoices.length];
          try {
            const result = await placeBuildingOnMap(
              mapData,
              {
                x: building.rect.x,
                y: building.rect.y,
                width: building.rect.width,
                height: building.rect.height,
                wallHeight: building.wallHeight,
                wallKind: 'roofSet' in choice ? wallKind : undefined,
                roofSet: 'roofSet' in choice ? choice.roofSet : undefined,
                roofKind: 'roofKind' in choice ? choice.roofKind : undefined,
                roofLayer,
                door: true,
                doorOffsetX: building.doorOffsetX,
                doorSide: building.doorSide,
                doorSprite: TOWN_DOOR_SPRITE,
                doorSpriteIndex: 0,
                allowRoofOverEmptyGround: false,
              },
              ctx
            );
            placed++;
            if (result.doorEventId !== null) doors++;
          } catch (error) {
            if (error instanceof BuildingPlacementError) {
              failures.push(`(${building.rect.x}, ${building.rect.y}): ${error.message.split('\n')[0]}`);
            } else {
              throw error;
            }
          }
        }

        // A run where every building was refused used to reach the end, write
        // the file and report itself a success. Judged here — before the props
        // and before the only write — so a refusal leaves the map as it was
        // rather than replacing it with streets and scenery.
        const outcome = assessTownBuild(
          plan.buildings.length,
          placed,
          failures,
          args.minBuildingWidth
        );
        if (outcome.refusal !== null) {
          const detail = failures.length > 1
            ? ['', 'The rest:', ...failures.slice(1, 5).map((f) => `  ${f}`)]
            : [];
          return errorResult([outcome.refusal, ...detail].join('\n'));
        }

        // --- props ---
        const catalogue = collectProps(tileset.tilesetNames);
        const missing: string[] = [];
        const placements: Placement[] = [];

        const decorNames = args.decorProps ?? DEFAULT_DECOR;
        const decorProps: Prop[] = [];
        for (const name of decorNames) {
          const found = findProps(catalogue, name);
          // Only single-tile props are scattered: anything bigger needs room the
          // slot list does not promise, and would land half on a wall.
          const single = found.find((p) => p.width === 1 && p.height === 1);
          if (single) decorProps.push(single);
          else missing.push(name);
        }

        if (decorProps.length > 0) {
          for (let i = 0; i < plan.decorSlots.length; i++) {
            const slot = plan.decorSlots[i];
            const prop = decorProps[i % decorProps.length];
            for (const cell of propCells(prop)) {
              placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
            }
          }
        } else if (decorNames.length > 0) {
          notes.push(
            `None of the requested decoration props exist in "${tileset.name}", so nothing was ` +
            'scattered. Use list_tileset_props to see what it offers.'
          );
        }

        let framed = 0;
        if (args.frameProp) {
          const frame = resolveFramingProp(catalogue, args.frameProp, TOWN_DEFAULTS.framePropHeight);
          if (frame) {
            for (const slot of plan.frameSlots) {
              for (const cell of propCells(frame)) {
                placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
              }
              framed++;
            }
          } else {
            notes.push(
              `No prop named "${args.frameProp}" in "${tileset.name}", so the map edge was left ` +
              'unframed.'
            );
          }
        }

        if (placements.length > 0) {
          const result = applyPlacements(readLayer(mapData, propLayer), placements, {
            skipOccupied: true,
            computeShapes: false,
          });
          writeLayer(mapData, propLayer, result.grid);
        }

        const shadows = applyWallShadows(mapData, { overwrite: false });

        // --- people ---
        // Placed here, not by a later populate_map pass: the plan already knows
        // which tiles are street, which are plot and — in `door.approach` —
        // exactly which tile each door is used from, so this is a guarantee
        // rather than a second pass inferring it from passage flags and sprite
        // names. Standability still comes from the finished map, because only
        // the tileset's flags know whether the ground that was painted can be
        // walked on.
        let npcs = 0;
        let npcRejected = 0;
        let npcRanOut = false;
        const missingSheets: string[] = [];
        let shopLine: string | null = null;
        let shopStock: string[] = [];

        const wantsPeople = args.npcCount > 0 || args.shop;
        const wanted = args.npcSheets ?? DEFAULT_NPC_SHEETS;
        const available = wantsPeople ? await listCharacterSheets(project.path) : [];
        const sheets = wanted.filter((s) => available.length === 0 || available.includes(s));
        if (wantsPeople) missingSheets.push(...wanted.filter((s) => !sheets.includes(s)));

        if (wantsPeople && sheets.length === 0) {
          // The town itself is fine; only its people could not be drawn. A
          // refusal here would throw away a good map over a missing PNG.
          notes.push(
            `None of ${wanted.join(', ')} are in img/characters, so the town was left empty. ` +
            'Use list_character_sheets to see what the project has, and pass npcSheets.'
          );
        } else if (wantsPeople) {
          const people = planTownPeople(plan);
          const standable = standableGrid(mapData, tileset.flags);
          const canStep = (ax: number, ay: number, bx: number, by: number): boolean => {
            const dx = bx - ax;
            const dy = by - ay;
            const d = (dx === 1 ? 6 : dx === -1 ? 4 : dy === 1 ? 2 : 8) as Direction;
            return canPass(mapData, tileset.flags, ax, ay, d);
          };
          const takenTiles = () =>
            mapData.events.filter((e) => e !== null).map((e) => ({ x: e!.x, y: e!.y }));

          // The shop goes down before the townsfolk, so its tile is already an
          // event by the time they are placed and none of them can take it. It
          // runs through planNpcPlacement like everyone else rather than being
          // dropped on a coordinate, which is what earns it the same guarantee:
          // a keeper who would seal off an alley is refused too.
          if (args.shop) {
            const shopPlan = planTownShop(plan, people);
            if (shopPlan === null || shopPlan.candidates.length === 0) {
              notes.push(
                shopPlan === null
                  ? 'No building to make a shop of, so the town has no merchant.'
                  : 'Every tile beside the chosen shop door was taken, so the town has no ' +
                    'merchant. The door approach itself is deliberately not used — a keeper ' +
                    'standing there would block the shop it belongs to.'
              );
            } else {
              const stock = await loadPresetStock(
                project.dataPath,
                args.shopPreset,
                args.shopStockCount,
                args.shopPriceBand as [number, number] | undefined
              );
              if (stock.refusal !== null) {
                notes.push(`${stock.refusal} The town was built without a shop.`);
              } else {
                const spot = planNpcPlacement(standable, {
                  count: 1,
                  seed,
                  allow: shopPlan.candidates,
                  blocked: [...people.blocked, ...takenTiles()],
                  canStep,
                });
                if (spot.placed.length === 0) {
                  notes.push(
                    'The shopkeeper was refused every tile beside its door — standing on any ' +
                    'of them would have sealed part of the town off. No merchant was placed.'
                  );
                } else {
                  const at = spot.placed[0];
                  const greeting = args.shopGreeting ?? SHOP_GREETINGS[args.shopPreset];
                  const sheet = sheets[0];
                  const keeper = addEvent(mapData, (id) =>
                    npcEvent(id, at.x, at.y, 'Shop', {
                      characterName: sheet,
                      characterIndex: charactersOnSheet(sheet) === 1 ? 0 : (seed + 3) % 8,
                      text: greeting,
                      movement: 'fixed',
                      commands: shopCommands(stock.goods, false),
                    })
                  );
                  const b = shopPlan.building.rect;
                  shopLine =
                    `Shop: event ${keeper.id} at (${at.x}, ${at.y}), beside the door of the ` +
                    `${b.width}x${b.height} building at (${b.x}, ${b.y}) — the one nearest the ` +
                    `middle of the map. ${stock.goods.length} row(s) of ${args.shopPreset} stock.`;
                  shopStock = describeGoods(stock.goods, stock.names);
                }
              }
            }
          }

          if (args.npcCount > 0) {
            const placement = planNpcPlacement(standable, {
              count: args.npcCount,
              seed,
              allow: people.candidates,
              blocked: [...people.blocked, ...takenTiles()],
              canStep,
            });
            npcRejected = placement.rejected;
            npcRanOut = placement.ranOut;

            const dialogue = args.npcDialogue ?? DEFAULT_NPC_DIALOGUE;
            for (let i = 0; i < placement.placed.length; i++) {
              const slot = placement.placed[i];
              const sheet = sheets[i % sheets.length];
              const index = charactersOnSheet(sheet) === 1 ? 0 : (seed + i) % 8;
              addEvent(mapData, (id) =>
                npcEvent(id, slot.x, slot.y, `${args.npcNamePrefix} ${i + 1}`, {
                  characterName: sheet,
                  characterIndex: index,
                  text: dialogue.length > 0 ? dialogue[i % dialogue.length] : '',
                  movement: args.npcMovement as MoveType,
                })
              );
              npcs++;
            }
          }
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Generated town on map ${mapId}: ${placed} buildings, ${plan.roads.length} streets, seed ${seed}`
        );

        const northFacing = plan.buildings.filter((b) => b.doorSide === 'top').length;

        const lines = [
          `Generated a town on map ${mapId} (${mapData.width}x${mapData.height}), seed ${seed}.`,
          '',
          `Streets: ${plan.roads.length} (${plan.bands.length} band(s) of buildings, ` +
            `${args.crossStreets} cross street(s)). They run to the map edge, so the town has ways in.`,
          `${outcome.summary}, ${doors} with door events. ` +
            (northFacing === 0
              ? 'Every door faces the street below its building.'
              : `${northFacing} of them face the street above their building instead, so ` +
                `${plan.buildings.length - northFacing} street frontage(s) run along the ` +
                'south side of a road and the rest along the north. Every door faces a street.'),
          `Decoration: ${plan.decorSlots.length} prop(s) on free ground, ${framed} framing the edge.`,
          `People: ${npcs} of ${args.npcCount} townsfolk, on streets and open ground. ` +
            'None on a door approach tile, and none anywhere that standing would seal ' +
            'part of the town off.',
          `Shadows: ${shadows.added} tile(s).`,
        ];
        if (shopLine !== null) {
          lines.push('', shopLine, ...shopStock.map((g) => `  ${g}`));
        }
        if (clearedEvents > 0) {
          lines.push(`Cleared ${clearedEvents} event(s) that were already on the map.`);
        }
        if (args.bothSidesOfStreet && northFacing === 0 && plan.bands.length > 1) {
          // Say why the option did nothing rather than letting the caller
          // conclude it is broken.
          lines.push(
            '',
            `bothSidesOfStreet was on but no north-facing row fitted: a bandHeight of ` +
            `${args.bandHeight} splits into ${Math.floor((args.bandHeight - 1) / 2)} rows for ` +
            'the north row, and the shortest legal building here is ' +
            `${Math.max(args.minBuildingHeight, args.wallHeight + 2)} (max of minBuildingHeight ` +
            'and wallHeight plus two roof rows). Raise bandHeight, or lower minBuildingHeight, ' +
            'to build up both sides of a street.'
          );
        }
        if (keptNote !== null) lines.push('', keptNote);

        if (failures.length > 0) {
          lines.push(
            '',
            `${failures.length} building(s) were refused:`,
            ...failures.slice(0, 5).map((f) => `  ${f}`)
          );
        }
        if (missing.length > 0) {
          lines.push(
            '',
            `Not in this tileset, so skipped: ${missing.join(', ')}. ` +
            '(Only 1x1 props are scattered; a name that resolves to a larger prop counts as missing.)'
          );
        }
        if (missingSheets.length > 0) {
          lines.push('', `Not in img/characters, so skipped: ${missingSheets.join(', ')}.`);
        }
        if (npcRejected > 0) {
          lines.push(
            '',
            `${npcRejected} tile(s) were passed over for townsfolk because standing there would ` +
            'have sealed off part of the town — a gap between two buildings, usually.'
          );
        }
        if (npcRanOut) {
          lines.push(
            '',
            'The town ran out of tiles that could take a townsperson without cutting something ' +
            'off. Lower npcCount, or make the map bigger.'
          );
        }
        if (npcs > 0 && !args.npcDialogue) {
          lines.push(
            '',
            'The townsfolk speak the built-in placeholder lines. Pass npcDialogue to give them ' +
            'something worth reading.'
          );
        }
        if (npcs > 0 && args.npcMovement === 'random') {
          lines.push(
            '',
            'These townsfolk wander. The connectivity check only holds for where they start — a ' +
            'wandering NPC can stand in a doorway at runtime, which no static check can see.'
          );
        }

        lines.push(
          '',
          'Layout:',
          '  # building  + door  = street  T tree line  o prop  . open ground',
          renderTownAscii(plan),
          '',
          ...notes.map((n) => `Note: ${n}`),
          '',
          'Run check_map_walkability to confirm every door is reachable and nothing is sealed off. ' +
          'Doors lead nowhere until you make interior maps and point them at one — the generator ' +
          'does not build interiors.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
