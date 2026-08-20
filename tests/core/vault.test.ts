import { describe, it, expect } from 'vitest';
import {
  hintText,
  defaultTheme,
  signPage,
  signEvent,
  THEME_COPY,
  VAULT_THEMES,
} from '../../src/core/vault.js';

/**
 * The prose here is written, not measured, and only its *structure* is pinned:
 * the direction clause has to follow the placement, because it is the one
 * sentence a player could catch out. The sign page rests on 39 measured
 * text-only events (37 Action Button) and on the engine for its priority.
 * describeDirection/describeDistance moved to geometry.test.ts along with the
 * functions themselves.
 */

describe('hintText', () => {
  it('follows the placement it was given', () => {
    const text = hintText('treasury', 'key', { x: 10, y: 10 }, { x: 30, y: 12 });
    expect(text).toContain(THEME_COPY.treasury.inscription);
    expect(text).toContain('to the east');
    expect(text).toContain('a long way');
  });

  it('says mechanism rather than key for a lever', () => {
    const text = hintText('armoury', 'lever', { x: 10, y: 10 }, { x: 10, y: 2 });
    expect(text).toContain('mechanism');
    expect(text).toContain('north');
    expect(text).not.toContain('The key lies');
  });

  it('does not leave a sign contradicting the door beside it', () => {
    // The armoury's key copy says "no key, no blade" — on a lever-locked door
    // that is a sign arguing with the mechanism.
    const lever = hintText('armoury', 'lever', { x: 10, y: 10 }, { x: 30, y: 10 });
    expect(lever).not.toContain('key');
    expect(lever).toBe(
      `${THEME_COPY.armoury.leverInscription} The mechanism that opens it stands some way to the east.`
    );
  });

  it('drops the lead entirely when there is no direction to give', () => {
    const text = hintText('crypt', 'key', { x: 4, y: 4 }, { x: 4, y: 4 });
    expect(text).toBe(THEME_COPY.crypt.inscription);
  });
});

describe('defaultTheme', () => {
  it('rotates, so two locks on one floor are two different rooms', () => {
    // Not variety for its own sake: a key is reused by name, so two treasuries
    // on one floor would share a key and the second door would be free.
    expect(defaultTheme(0)).not.toBe(defaultTheme(1));
  });

  it('wraps rather than running off the end', () => {
    expect(defaultTheme(VAULT_THEMES.length)).toBe(defaultTheme(0));
  });
});

describe('THEME_COPY', () => {
  it('gives every theme a key name of its own', () => {
    const names = VAULT_THEMES.map((t) => THEME_COPY[t].keyName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('draws each room from databases that suit it', () => {
    // The fiction reaches the loot table rather than stopping at the text.
    expect(THEME_COPY.armoury.rewardKinds).toEqual(['weapon', 'armor']);
    expect(THEME_COPY.storeroom.rewardKinds).toEqual(['item']);
  });
});

describe('signPage', () => {
  it('is Action Button, which 37 of the 39 measured text events are', () => {
    expect(signPage('Hello').trigger).toBe(0);
  });

  it('blocks nothing when it has no sprite', () => {
    // It goes beside a door standing on a chokepoint, where a blocking event
    // could cut the floor in half. triggerButtonAction starts a priority-0
    // event through checkEventTriggerHere([0]) when the player stands on it.
    expect(signPage('Hello').priorityType).toBe(0);
  });

  it('blocks its tile once it is something you can see', () => {
    expect(signPage('Hello', { characterName: '!Other1' }).priorityType).toBe(1);
  });

  it('says one thing and stops', () => {
    const page = signPage('Sealed by the last of us.');
    expect(page.list.map((c) => c.code)).toEqual([101, 401, 0]);
    expect(page.list[1].parameters[0]).toBe('Sealed by the last of us.');
    // MZ's Show Text carries the speaker name as a fifth parameter.
    expect(page.list[0].parameters).toEqual(['', 0, 0, 2, '']);
  });

  it('wraps, because a message box is four lines and measures pixels', () => {
    // An inscription emitted as one 401 runs off the window. The longest theme
    // copy plus its direction clause is well over one line.
    const long = THEME_COPY.crypt.inscription + ' The key lies a long way to the north-west.';
    const page = signPage(long);
    const bodies = page.list.filter((c) => c.code === 401);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(String(body.parameters[0]).length).toBeLessThanOrEqual(46);
    }
    // and every fourth line opens a new box
    expect(page.list.filter((c) => c.code === 101)).toHaveLength(Math.ceil(bodies.length / 4));
  });

  it('never leaves an unclosed quotation in the copy', () => {
    for (const theme of VAULT_THEMES) {
      for (const text of [THEME_COPY[theme].inscription, THEME_COPY[theme].leverInscription]) {
        expect((text.match(/'/g) ?? []).length % 2).toBe(0);
        expect(text).not.toContain('"');
      }
    }
  });

  it('never mentions a key in the lever copy', () => {
    for (const theme of VAULT_THEMES) {
      expect(THEME_COPY[theme].leverInscription.toLowerCase()).not.toContain('key');
    }
  });

  it('can fire on touch for a caller who would rather not be missed', () => {
    expect(signPage('Hello', { trigger: 1 }).trigger).toBe(1);
  });
});

describe('signEvent', () => {
  it('names itself after its id when nothing else is given', () => {
    expect(signEvent(5, 2, 3, 'Hello')).toMatchObject({
      id: 5,
      name: 'Inscription5',
      x: 2,
      y: 3,
    });
  });
});
