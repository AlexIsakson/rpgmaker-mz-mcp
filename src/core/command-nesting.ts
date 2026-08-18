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
 * The same is true of the other two block constructs, which are the same
 * machinery: `command411` (Else) skips when the branch was *taken*,
 * `command402` (When) skips when a different choice was picked, and
 * `command413` (Repeat Above) walks `_index` backwards until it finds a command
 * at its own indent. All of them are indent arithmetic.
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

export type BlockKind = 'branch' | 'loop' | 'choice';

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
      out.push({ command, indent });
      stack.push({
        spec: opener,
        indent,
        at: i,
        dividersSeen: [],
        bodyOpen: opener.bodyFollowsOpener,
      });
      indent += 1;
      continue;
    }

    // A plain command. Inside a choice block it has to be inside a `when`, or
    // the engine runs it before any choice has been made.
    const block = innermost();
    if (block !== null && !block.bodyOpen) {
      throw new NestingError(
        `${ordinal(i)} (${type}) sits between ${describeOpen(block)} and its first ` +
          'when_choice. The engine runs those commands before the player has chosen ' +
          'anything — put them before the show_choices, or inside a when_choice.'
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
  const maxSteps = decisions.maxSteps ?? 10000;

  // Game_Interpreter._branch, keyed by indent.
  const branch = new Map<number, boolean | number>();
  let branchesSeen = 0;
  let choicesSeen = 0;
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
