/**
 * Small geometry helpers for turning two tile coordinates into words a sign
 * or an NPC would use. Split out of vault.ts so npcgen.ts can reuse the same
 * phrasing without the two modules importing each other — vault.ts already
 * depends on npcgen.ts for dialogueCommands.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Which way `to` lies from `from`, in words.
 *
 * Screen coordinates, so a larger y is south. A diagonal is only named when
 * both components are worth mentioning — "north-east" for a point that is
 * barely east of `from` reads as a wrong answer even though it is a true one,
 * so the lesser axis has to be at least half the greater to be named at all.
 */
export function describeDirection(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 'right here';

  const horizontal = dx > 0 ? 'east' : 'west';
  const vertical = dy > 0 ? 'south' : 'north';

  if (Math.abs(dx) >= Math.abs(dy) * 2) return horizontal;
  if (Math.abs(dy) >= Math.abs(dx) * 2) return vertical;
  return `${vertical}-${horizontal}`;
}

/** How far apart two tiles are, in words a sign would use. */
export function describeDistance(from: Point, to: Point): string {
  const steps = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (steps <= 6) return 'not far';
  if (steps <= 20) return 'some way';
  return 'a long way';
}
