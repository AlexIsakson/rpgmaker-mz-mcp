import { A2_KIND_MAX, A2_KIND_MIN, type A2Material } from './tileset-image.js';

/**
 * Is this material fit for the layer it is about to be painted on?
 *
 * Visual review finding 1: an A2 material whose *edge* pieces are partly
 * transparent is an overlay — it is drawn over a ground material, and on layer 0
 * there is nothing under it but the map background, which the engine draws as
 * black. `fill_map_region` and `paint_tiles` refused this. The generators, which
 * paint far more of the map in one call than either, did not.
 *
 * **How big the trap is, measured** by running `classifyA2Sheet` over the four
 * A2 sheets the RTP ships (32 kinds each, 128 in all):
 *
 * | sheet | ground | overlay | empty |
 * |---|---|---|---|
 * | `Dungeon_A2` | 26 | 4 | 2 |
 * | `Inside_A2` | 23 | 5 | 4 |
 * | `Outside_A2` | 17 | 11 | 4 |
 * | `World_A2` | 8 | 23 | 1 |
 * | **total** | **74** | **43** | **11** |
 *
 * So **54 of 128 kinds — 42% — cannot go on layer 0 at all**, and on `World_A2`
 * only 8 of 32 can. A caller picking a kind without asking is wrong about
 * two-fifths of the time, and on a world tileset three-quarters of the time.
 * That is why this is a refusal and not a note.
 *
 * The two shipped defaults happen to be safe — kind 16 (`generate_town`'s
 * `groundKind`) and kind 32 (`generate_interior`'s `floorKind`) classify as
 * ground in all four sheets — so the trap only springs when a caller chooses,
 * which is exactly when nothing else is looking.
 *
 * This module is pure: it is handed already-classified materials and returns
 * text. Loading the sheet is the tool's job.
 */

export interface GroundKindRequest {
  /** The autotile kind the caller asked for. */
  kind: number;
  /** The argument it came from, so the refusal says which one was wrong. */
  label: string;
  /**
   * Layer it will be painted on. Only layer 0 has nothing beneath it, so an
   * overlay is only a problem there. Defaults to 0.
   */
  layer?: number;
  /**
   * True when this kind covers the whole map. A seamless material — one whose
   * edge pieces are drawn like its middle — is right for a base fill and wrong
   * for a patch, which is advice rather than a refusal.
   */
  coversMap?: boolean;
}

export interface GroundCheckResult {
  /** The refusal text, or null when nothing was wrong. */
  refusal: string | null;
  /** Advice worth reporting alongside a successful write. */
  notes: string[];
}

export interface GroundCheckOptions {
  /** The caller meant it: check nothing, report nothing. */
  allowOverlayOnGround?: boolean;
  /**
   * Say so when the A2 sheet could not be read. Off by default because a paint
   * tool that says "I could not check" on every call is noise; a generator that
   * repaints a whole map is worth the line.
   */
  reportUncheckable?: boolean;
}

/** Kinds outside 16-47 are A1 water or A3/A4 walls, which this does not classify. */
export function isA2Kind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= A2_KIND_MIN && kind <= A2_KIND_MAX;
}

/**
 * Which of these kinds must not go on layer 0, in ascending order.
 *
 * The judgement, without the wording around it — for callers whose situation
 * needs a different remedy than "pick another material". `paint_tiles` uses it,
 * because its advice is about moving *entries of a batch* to another layer, not
 * about one wrong argument. One place decides what is bad; the phrasing is the
 * tool's own.
 */
export function overlayKindsAmong(
  kinds: Iterable<number>,
  materials: A2Material[] | null
): number[] {
  if (materials === null) return [];
  const bad: number[] = [];
  for (const kind of kinds) {
    if (!isA2Kind(kind)) continue;
    const material = materials.find((m) => m.kind === kind);
    if (material && material.opacity !== 'ground') bad.push(kind);
  }
  return bad.sort((a, b) => a - b);
}

const article = (m: A2Material) =>
  m.opacity === 'empty' ? 'an empty slot on the sheet' : 'an overlay material';

/**
 * Check every ground-layer material a call is about to paint, in one pass.
 *
 * All of them are checked before any refusal is returned, so a caller who got
 * two of them wrong is told about both rather than discovering the second after
 * fixing the first.
 */
export function checkGroundKinds(
  requests: GroundKindRequest[],
  materials: A2Material[] | null,
  tilesetName: string,
  options: GroundCheckOptions = {}
): GroundCheckResult {
  const notes: string[] = [];

  // A2/A3/A4 mixed arguments are normal — `surroundKind` takes a wall kind as
  // often as a ground one — so a non-A2 kind is skipped, not refused. Walls are
  // opaque by construction; there is nothing to check.
  const onGround = requests.filter((r) => isA2Kind(r.kind) && (r.layer ?? 0) === 0);
  if (onGround.length === 0) return { refusal: null, notes };

  if (materials === null) {
    // loadA2Materials returns null when the sheet is missing or unreadable.
    // Degrading to "no advice" beats failing a paint over a missing PNG — but
    // saying nothing at all would hide that the check did not happen.
    if (options.reportUncheckable) {
      notes.push(
        `Note: the A2 sheet for tileset "${tilesetName}" could not be read, so ` +
        `${onGround.map((r) => r.label).join(' and ')} were not checked for transparency. ` +
        'If the map renders with black patches, that is why.'
      );
    }
    return { refusal: null, notes };
  }

  const bad: { request: GroundKindRequest; material: A2Material }[] = [];
  for (const request of onGround) {
    const material = materials.find((m) => m.kind === request.kind);
    if (!material) continue;
    if (material.opacity !== 'ground') bad.push({ request, material });
  }

  if (bad.length > 0 && !options.allowOverlayOnGround) {
    const listed = bad
      .map(({ request, material }) =>
        `A2 kind ${request.kind} (${request.label}) is ${article(material)}`
      )
      .join('; ');

    return {
      refusal:
        `${listed} — in tileset "${tilesetName}". An overlay's edge pieces are transparent and ` +
        'an empty slot has no art at all, so on layer 0 either one shows the map background, ' +
        'which the engine draws as black. Nothing was written.\n\n' +
        'Pick a ground material instead. Which kinds are ground cannot be read off the sheet ' +
        'column — it differs per tileset — so ask describe_tileset_materials. Pass ' +
        'allowOverlayOnGround if this is deliberate.',
      notes,
    };
  }

  // Seamless is never a refusal: it is the right choice for a base fill and the
  // wrong one for a patch, and only the caller knows which this is.
  for (const request of onGround) {
    if (request.coversMap !== false) continue;
    const material = materials.find((m) => m.kind === request.kind);
    if (material?.outline !== 'seamless') continue;
    notes.push(
      `Note: A2 kind ${request.kind} (${request.label}) is a seamless fill — its edge pieces ` +
      'are drawn the same as its middle, so it will have no visible boundary against what ' +
      'surrounds it. That suits a whole-map base fill; for a patch, path or street an ' +
      'outlined material reads better (describe_tileset_materials lists them).'
    );
  }

  return { refusal: null, notes };
}
