/**
 * Block structure in an event command list — the thing that makes a
 * conditional branch actually gate.
 *
 * `add_event_commands` emitted every command at `indent: 0`. That is not a
 * cosmetic detail: **indent is the only thing the engine uses to find the end
 * of a block.** `Game_Interpreter.executeCommand` sets `this._indent` from the
 * command it is about to run, and every branch is skipped by
 *
 * ```js
 * Game_Interpreter.prototype.skipBranch = function() {
 *     while (this._list[this._index + 1].indent > this._indent) {
 *         this._index++;
 *     }
 * };
 * ```
 *
 * With a flat list nothing is ever deeper than the branch, so `skipBranch`
 * advances zero commands and the body runs whether the condition held or not.
 * A `conditional_branch` built through the tool was decoration.
 *
 * The same is true of the other block constructs, which are the same machinery:
 * `command411` (Else) skips when the branch was *taken*, `command402` (When)
 * skips when a different choice was picked, `command601`/`602`/`603` (If Win /
 * If Escape / If Lose) each skip unless `_branch[_indent]` matches the result
 * `BattleManager.endBattle` handed back, and `command413` (Repeat Above) walks
 * `_index` backwards until it finds a command at its own indent. All of them
 * are indent arithmetic.
 *
 * Battles were measured separately, because `battle_processing` is the one
 * opener that is also a complete command on its own. Of the **13** in the
 * corpus, **11 are immediately followed by a 601 at the same indent** and 2
 * carry no arms at all. Among the 11, the arm order is **Win → [Escape] → Lose
 * → End without exception** — 9 are `601 > 603 > 604` and 2 are
 * `601 > 602 > 603 > 604` — and an escape arm appears in exactly the 2 whose
 * `canEscape` is true. All 11 set `canLose: true`; both armless battles set it
 * false.
 *
 * **Measured over the corpus** — 3014 command lists across the 293 sample maps,
 * the `newdata` reference project and the three projects under
 * `M:/Projects/RPGMZ`, 11172 commands in all. Only **37 lists contain a branch,
 * loop or choice at all**, so this is a thin sample of structure — but within it
 * the rules hold without a single exception, which is what makes them safe to
 * encode:
 *
 *  - **All 3014 lists end with `{code: 0, indent: 0}`.** This is what keeps
 *    `skipBranch`'s unguarded `this._list[this._index + 1]` from running off the
 *    end, so the terminator is load-bearing rather than tidy.
 *  - **All 82 block markers sit at the same indent as their opener** (9 `else`,
 *    34 `end_if`, 27 `when`, 9 `end_choices`, 3 `repeat_above`); 0 at any other
 *    indent. The marker is part of the opener's line, not of its body.
 *  - **All 34 conditional branches are closed by a 412.** None is left open.
 *  - **All 34 branches and all 3 loops are followed by a deeper command**, while
 *    **all 9 `show_choices` are followed by a 402 at the *same* indent**. So a
 *    choice's body does not start until its first `when`, which is the one place
 *    the three constructs differ.
 *  - **All 95 mid-list `{code: 0}` commands sit immediately before a marker at a
 *    shallower indent** — the blank line the editor leaves at the end of every
 *    block body. Emitting it costs nothing at runtime (there is no `command0`
 *    method) and makes the output look like a file the editor wrote.
 *
 * Deepest indent seen anywhere is 3 (10225 commands at 0, 829 at 1, 113 at 2,
 * 5 at 3), which is a fact about hand-made events rather than a limit — nothing
 * in the engine caps it, and nothing here does either.
 *
 * This module is pure: it takes a flat list of human-readable commands and
 * returns the indent each one belongs at, or refuses.
 */

export class NestingError extends Error {}

/** A command as the caller writes it — a type plus whatever that type needs. */
export interface NestedCommand {
  type: string;
  [key: string]: unknown;
}

export type BlockKind = 'branch' | 'loop' | 'choice' | 'battle';

interface BlockSpec {
  kind: BlockKind;
  opener: string;
  /** Markers that divide the block, emitted at the opener's own indent. */
  dividers: string[];
  /** The marker that closes it, also at the opener's indent. */
  closer: string;
  /**
   * False when the opener's body does not begin until a divider — the
   * `show_choices` case, where all 9 in the corpus are followed by a `when` at
   * the same indent rather than by body content.
   */
  bodyFollowsOpener: boolean;
  /**
   * True when the opener is only an opener if a divider follows it.
   * `battle_processing` on its own is a complete command — 2 of the 13 in the
   * corpus have no arms at all — so it opens a block only when one is written.
   */
  opensOnlyBeforeDividers?: boolean;
  /**
   * True when the dividers must appear in the order they are declared, each at
   * most once. Measured for battles: all 11 armed battles in the corpus run
   * Win → [Escape] → Lose, with no other order and no repeats. Choices are the
   * opposite — `when_choice` repeats, once per option.
   */
  orderedDividers?: boolean;
}

const BLOCKS: BlockSpec[] = [
  {
    kind: 'branch',
    opener: 'conditional_branch',
    dividers: ['else'],
    closer: 'end_branch',
    bodyFollowsOpener: true,
  },
  {
    kind: 'loop',
    opener: 'loop',
    dividers: [],
    closer: 'repeat_above',
    bodyFollowsOpener: true,
  },
  {
    kind: 'choice',
    opener: 'show_choices',
    dividers: ['when_choice', 'when_cancel'],
    closer: 'end_choices',
    bodyFollowsOpener: false,
  },
  {
    kind: 'battle',
    opener: 'battle_processing',
    dividers: ['if_win', 'if_escape', 'if_lose'],
    closer: 'end_battle',
    bodyFollowsOpener: false,
    opensOnlyBeforeDividers: true,
    orderedDividers: true,
  },
];

const OPENERS = new Map(BLOCKS.map((b) => [b.opener, b]));
const CLOSERS = new Map(BLOCKS.map((b) => [b.closer, b]));
const DIVIDERS = new Map(
  BLOCKS.flatMap((b) => b.dividers.map((d) => [d, b] as [string, BlockSpec]))
);

/** Every type this module treats as structure rather than as an action. */
export function isStructuralType(type: string): boolean {
  return OPENERS.has(type) || CLOSERS.has(type) || DIVIDERS.has(type);
}

export interface PlacedCommand {
  command: NestedCommand;
  indent: number;
  /**
   * True for the blank line that closes a block body — the editor's own
   * convention, emitted as `{code: 0, indent}` and ignored by the interpreter.
   */
  blockBodyEnd?: boolean;
}

interface OpenBlock {
  spec: BlockSpec;
  indent: number;
  /** 1-based position of the opener, for the refusal text. */
  at: number;
  dividersSeen: string[];
  /** False until a divider has been seen, for a choice block. */
  bodyOpen: boolean;
}

const ordinal = (index: number) => `command ${index + 1}`;

/** `else`, `end_branch` and `end_choices` all want "an". */
const withArticle = (type: string) => `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;

function describeOpen(block: OpenBlock): string {
  return `the ${block.spec.opener} at ${ordinal(block.at)}`;
}

/**
 * Whether an optional opener is being used as a block here.
 *
 * Looks past plain commands to the first structural one: if that belongs to
 * this block, the caller meant to open one — even if they put a command in the
 * wrong place first, which is then refused as the misplacement it is.
 */
function opensBlockAt(commands: NestedCommand[], from: number, spec: BlockSpec): boolean {
  for (let j = from; j < commands.length; j++) {
    const next = commands[j]?.type ?? '';
    if (!isStructuralType(next)) continue;
    return spec.dividers.includes(next) || next === spec.closer;
  }
  return false;
}

/**
 * An `if_lose` arm on a battle the party is not allowed to lose can never run.
 *
 * `BattleManager.updateBattleEnd` is explicit about it:
 *
 * ```js
 * } else if (!this._escaped && $gameParty.isAllDead()) {
 *     if (this._canLose) {
 *         $gameParty.reviveBattleMembers();
 *         SceneManager.pop();
 *     } else {
 *         SceneManager.goto(Scene_Gameover);
 *     }
 * }
 * ```
 *
 * `endBattle(2)` does fire the callback, so `_branch[_indent]` really is set to
 * 2 — but the scene goes to Game Over instead of back to the map, so the
 * interpreter never resumes and the arm is dead code.
 *
 * The escape arm is deliberately *not* treated the same way, even though the
 * corpus correlation is just as tight (all 11 armed battles carry an escape arm
 * exactly when `canEscape` is true). Result 1 has three routes —
 * `onEscapeSuccess`, `processPartyEscape`, and `checkAbort` after the Abort
 * Battle command (340) from a troop page — and only the first needs
 * `canEscape`. An escape arm on a no-escape battle is unusual, not unreachable.
 */
function rejectUnreachableLoseArm(
  opener: NestedCommand | undefined,
  index: number,
  block: OpenBlock
): void {
  // Matches convertCommand's default for battle_processing.
  const canLose = (opener?.canLose as boolean | undefined) ?? false;
  if (canLose) return;
  throw new NestingError(
    `${ordinal(index)} is an if_lose arm, but ${describeOpen(block)} does not set ` +
      'canLose: true. BattleManager.updateBattleEnd sends a party wipe straight to ' +
      'Scene_Gameover unless canLose is set, so the interpreter never comes back and this arm ' +
      'can never run. Set canLose: true to handle the defeat, or drop the arm.'
  );
}

/**
 * Work out what indent every command belongs at, and refuse a list whose blocks
 * do not balance.
 *
 * Indent is computed, never supplied: a caller who could set it by hand could
 * write a list the engine walks differently from the way it reads, which is the
 * bug this module exists to remove.
 */
export function assignIndents(commands: NestedCommand[]): PlacedCommand[] {
  const out: PlacedCommand[] = [];
  const stack: OpenBlock[] = [];
  let indent = 0;

  const innermost = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const type = command.type;

    if (command.indent !== undefined) {
      throw new NestingError(
        `${ordinal(i)} sets indent by hand. Indent is computed from the block structure — ` +
          'use conditional_branch / else / end_branch (and loop / repeat_above, ' +
          'show_choices / when_choice / end_choices) to nest, so what the engine walks and ' +
          'what the list reads as cannot disagree.'
      );
    }

    const closer = CLOSERS.get(type);
    const divider = DIVIDERS.get(type);
    const opener = OPENERS.get(type);

    if (closer !== undefined) {
      const block = innermost();
      if (block === null) {
        throw new NestingError(
          `${ordinal(i)} is ${withArticle(type)} with nothing open to close. Every ${closer.closer} ` +
            `needs a ${closer.opener} before it.`
        );
      }
      if (block.spec.kind !== closer.kind) {
        throw new NestingError(
          `${ordinal(i)} is ${withArticle(type)}, but the innermost open block is ${describeOpen(block)}. ` +
            `Close that with ${block.spec.closer} first — blocks cannot cross.`
        );
      }
      stack.pop();
      indent = block.indent;
      // The editor leaves a blank line at the end of every block body; all 95
      // mid-list code-0 commands in the corpus sit exactly here.
      out.push({ command: { type: 'blank' }, indent: indent + 1, blockBodyEnd: true });
      out.push({ command, indent });
      continue;
    }

    if (divider !== undefined) {
      const block = innermost();
      if (block === null) {
        throw new NestingError(
          `${ordinal(i)} is ${withArticle(type)} with nothing open for it to divide. It belongs inside a ` +
            `${divider.opener}.`
        );
      }
      if (block.spec.kind !== divider.kind) {
        throw new NestingError(
          `${ordinal(i)} is ${withArticle(type)}, which belongs to a ${divider.opener}, but the innermost ` +
            `open block is ${describeOpen(block)}.`
        );
      }
      // command411 tests `_branch[_indent] !== false`, so a second else would
      // read the same stored result and both arms would behave identically.
      if (type === 'else' && block.dividersSeen.includes('else')) {
        throw new NestingError(
          `${ordinal(i)} is a second else on ${describeOpen(block)}. A branch stores one ` +
            'result, so both else arms would test it the same way and run together.'
        );
      }
      if (block.spec.orderedDividers) {
        if (block.dividersSeen.includes(type)) {
          throw new NestingError(
            `${ordinal(i)} is a second ${type} on ${describeOpen(block)}. A battle ends one ` +
              'way, so the second arm could never run.'
          );
        }
        const seenLater = block.dividersSeen.find(
          (seen) => block.spec.dividers.indexOf(seen) > block.spec.dividers.indexOf(type)
        );
        if (seenLater !== undefined) {
          throw new NestingError(
            `${ordinal(i)} puts ${type} after ${seenLater} on ${describeOpen(block)}. The arms ` +
              `run in the order ${block.spec.dividers.join(', ')} — all 11 armed battles in the ` +
              'sample maps and projects are written that way, and the editor writes no other.'
          );
        }
      }
      if (type === 'if_lose') {
        rejectUnreachableLoseArm(commands[block.at], i, block);
      }
      block.dividersSeen.push(type);
      indent = block.indent;
      if (block.bodyOpen) {
        out.push({ command: { type: 'blank' }, indent: indent + 1, blockBodyEnd: true });
      }
      block.bodyOpen = true;
      out.push({ command, indent });
      indent = block.indent + 1;
      continue;
    }

    if (opener !== undefined) {
      // `battle_processing` is a complete command on its own — 2 of the 13 in
      // the corpus have no arms — so it only opens a block when one follows.
      // The lookahead steps over plain commands to the first structural one,
      // so `battle, show_text, if_win` is read as an armed battle with a
      // command in the wrong place, and refused as that rather than as a
      // stray if_win.
      const opensHere =
        !opener.opensOnlyBeforeDividers || opensBlockAt(commands, i + 1, opener);

      out.push({ command, indent });
      if (opensHere) {
        stack.push({
          spec: opener,
          indent,
          at: i,
          dividersSeen: [],
          bodyOpen: opener.bodyFollowsOpener,
        });
        indent += 1;
      }
      continue;
    }

    // A plain command. Inside a choice or battle block it has to be inside an
    // arm, or the engine runs it before the result that selects one exists.
    const block = innermost();
    if (block !== null && !block.bodyOpen) {
      const first = block.spec.dividers[0];
      throw new NestingError(
        `${ordinal(i)} (${type}) sits between ${describeOpen(block)} and its first ` +
          `${first}. The engine runs those commands before the ` +
          `${block.spec.kind === 'battle' ? 'battle result is known' : 'player has chosen anything'}` +
          ` — put them before the ${block.spec.opener}, or inside ${withArticle(first)}.`
      );
    }
    if (type === 'break_loop' && !stack.some((b) => b.spec.kind === 'loop')) {
      // command113 scans forward for a 413 and stops at the end of the list if
      // there is none, silently skipping everything after it.
      throw new NestingError(
        `${ordinal(i)} is a break_loop with no loop around it. command113 scans forward for ` +
          'the matching repeat_above and, finding none, runs to the end of the list — every ' +
          'command after it would be skipped.'
      );
    }
    out.push({ command, indent });
  }

  if (stack.length > 0) {
    const block = stack[stack.length - 1];
    throw new NestingError(
      `${describeOpen(block)} is never closed. Add ${block.spec.closer} — without it the ` +
        'block runs to the end of the list, and every command after it becomes part of ' +
        'the branch.'
    );
  }

  return out;
}

/**
 * The deepest indent a placed list reaches. Reported rather than capped: the
 * corpus stops at 3, but that is how deep hand-made events happen to go, not a
 * limit the engine imposes.
 */
export function maxIndent(placed: PlacedCommand[]): number {
  return placed.reduce((deepest, p) => Math.max(deepest, p.indent), 0);
}

// --- A port of the interpreter's walk, for testing ---------------------------

/** One command as the engine sees it: a code, an indent, and parameters. */
export interface WalkCommand {
  code: number;
  indent: number;
  parameters: unknown[];
}

export interface WalkDecisions {
  /** Result for the nth conditional branch (code 111) reached, in order. */
  branches?: boolean[];
  /** Chosen index for the nth show_choices (code 102) reached; -1 for cancel. */
  choices?: number[];
  /**
   * Outcome of the nth battle (code 301) reached: 0 win, 1 escape, 2 lose —
   * the values `BattleManager.endBattle` passes to its event callback. `null`
   * stands for the troop id not existing, where `command301` never installs the
   * callback at all and every arm is therefore skipped.
   */
  battles?: (number | null)[];
  /** Cap on iterations, since a loop with no break never finishes. */
  maxSteps?: number;
}

/**
 * Walk a command list the way `Game_Interpreter` does and report which commands
 * actually ran.
 *
 * This is a port of `executeCommand`, `skipBranch`, `command111`, `command411`,
 * `command402`, `command403`, `command413` and `command113` — the index
 * arithmetic only, with no game state. It exists so the nesting rules can be
 * checked against the engine's own walk rather than against the emitter that
 * produced them; testing `assignIndents` against a restatement of itself would
 * prove nothing.
 */
export function walkCommands(list: WalkCommand[], decisions: WalkDecisions = {}): number[] {
  const executed: number[] = [];
  const branchResults = decisions.branches ?? [];
  const choiceResults = decisions.choices ?? [];
  const battleResults = decisions.battles ?? [];
  const maxSteps = decisions.maxSteps ?? 10000;

  // Game_Interpreter._branch, keyed by indent.
  const branch = new Map<number, boolean | number>();
  let branchesSeen = 0;
  let choicesSeen = 0;
  let battlesSeen = 0;
  let index = 0;
  let indent = 0;
  let steps = 0;

  const skipBranch = () => {
    // Deliberately unguarded, exactly as the engine has it: a list that does
    // not end with a terminator throws here, which is the real behaviour.
    while (list[index + 1].indent > indent) index++;
  };

  while (index < list.length) {
    if (++steps > maxSteps) throw new Error(`walk did not terminate within ${maxSteps} steps`);
    const command = list[index];
    if (!command) break;
    indent = command.indent;
    executed.push(index);

    switch (command.code) {
      case 0:
        // No command0 method exists, so the engine treats it as a no-op. The
        // final one terminates only because _index runs past the list.
        break;
      case 111: {
        const result = branchResults[branchesSeen++] ?? false;
        branch.set(indent, result);
        if (result === false) skipBranch();
        break;
      }
      case 411:
        if (branch.get(indent) !== false) skipBranch();
        break;
      case 102: {
        branch.set(indent, choiceResults[choicesSeen++] ?? 0);
        break;
      }
      case 301: {
        // command301 only installs the callback when $dataTroops[troopId]
        // exists, so a missing troop leaves _branch[_indent] untouched. `null`
        // is checked before defaulting: `?? 0` would treat it as "not given".
        const outcome =
          battlesSeen < battleResults.length ? battleResults[battlesSeen] : 0;
        battlesSeen++;
        if (outcome === null) branch.delete(indent);
        else branch.set(indent, outcome);
        break;
      }
      case 601:
        if (branch.get(indent) !== 0) skipBranch();
        break;
      case 602:
        if (branch.get(indent) !== 1) skipBranch();
        break;
      case 603:
        if (branch.get(indent) !== 2) skipBranch();
        break;
      case 402:
        if (branch.get(indent) !== command.parameters[0]) skipBranch();
        break;
      case 403:
        if ((branch.get(indent) as number) >= 0) skipBranch();
        break;
      case 413: {
        do {
          index--;
        } while (list[index].indent !== indent);
        break;
      }
      case 113: {
        let depth = 0;
        while (index < list.length - 1) {
          index++;
          const c = list[index];
          if (c.code === 112) depth++;
          if (c.code === 413) {
            if (depth > 0) depth--;
            else break;
          }
        }
        break;
      }
      default:
        break;
    }

    index++;
  }

  return executed;
}
