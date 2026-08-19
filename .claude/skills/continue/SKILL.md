---
name: continue
description: Pick up the next unchecked task from TASKS.md and take it end to end — implement, test, verify, update the roadmap, commit and push. Use when the user types /continue, or asks to continue, resume, or do the next task on the rpgmaker-mz-mcp backlog.
---

# Continue the Phase 5 backlog

Take the next task from [TASKS.md](../../../TASKS.md) and finish it completely, following the
conventions in [CLAUDE.md](../../../CLAUDE.md).

If the user passed an argument, treat it as the task to do instead of the first unchecked one —
either an id (`P5-04`) or a phrase to match against task titles.

## 1. Orient before starting

Run these first, and do not skip them — a stale working tree is the main way this goes wrong:

```bash
git -C . status --short && git -C . log --oneline -3
```

- **Uncommitted changes present?** Stop and ask whether to commit, stash or discard them.
  Do not build on top of an unexplained diff.
- **Behind the remote?** `git pull` before starting.

Read TASKS.md and identify the first `- [ ]` task **in the planned sections** — everything above
`## Found while working`. That trailing section is not part of the queue: take from it only when
the plan's next task is blocked by one of its entries (say which, and why), or when the user names
one by id.

State to the user which task you are taking and what "done" means for it, in two or three
sentences. Then start — do not wait for approval unless the task is ambiguous or you disagree
with its framing.

## 2. Do the work

Follow the repo's method, which CLAUDE.md sets out in full. The parts that matter most here:

- **Measure before asserting.** The corpus is at
  `M:/SteamLibrary/steamapps/common/RPG Maker MZ/samplemaps/` (293 hand-made maps),
  with the reference database in `newdata/data/` and engine source in `corescript/`.
  Give counts, not impressions. If a sample is too thin to settle something, say so in the
  code comment rather than sounding confident.
- **Pure core module + tool wrapper + tests.** Logic goes in `src/core/<feature>.ts` with no
  file I/O; the tool in `src/tools/<feature>-tools.ts`; tests in `tests/core/<feature>.test.ts`.
- **Refuse rather than emit something broken**, and name what was wrong in the refusal.
- **Seeded generation stays reproducible.**

## 3. Verify

```bash
npm test && npm run build
```

Both must pass. If a pre-existing test fails, say so plainly rather than working around it.

**If the task changes what a map looks like, tests are not enough.** Drive the real server over
stdio MCP to build a map, render it with `node scripts/render-map.mjs`, and look at the PNG.
Several real bugs in this repo's history were invisible in a text grid. Send the render to the
user with SendUserFile so they can see it too.

Where the task touches walkability, run `check_map_walkability` and report the numbers.

## 4. Record it

Three files, every time:

1. **ROADMAP.md** — add or extend the section for this feature: what was measured, what the
   counts were, what is still open. This is the repo's long-form memory and the reason its claims
   hold up; a feature without its section is half done.
2. **TASKS.md** — tick the checkbox and update whichever of the two progress lines the task
   belonged to (`**Plan: n / 25**` or `**Found while working: n / m**`).

   If the work turned up something new, it goes in **one of two places, and choosing between
   them is part of the job**:

   - **A task, appended to the `## Found while working` section at the end** — never next to the
     task that found it. A discovered bug filed beside its parent inherits the parent's place at
     the head of the queue and pre-empts the plan; that is how 15 of the first 19 commits went on
     defects while the plan advanced 4 of 25. The bar is: **a player would notice, or a caller
     would be misled.**
   - **A ROADMAP paragraph where the measurement already is** — for everything smaller. Say
     plainly that it was not filed and why. A tool behaving as its own description promises is
     not a bug just because the behaviour is inconvenient.

   Either way the measurement gets written down. What changes is whether it takes a turn.
3. **CLAUDE.md** — only if a convention actually changed.

## 5. Commit and push

One commit for the whole task. Message style is `type: lowercase phrase describing the effect on
the game`, written for someone who cares about the result rather than the diff — match the
existing log (`feat: give the locked door a reason to exist`).

```bash
git add -A && git commit && git push
```

End the commit message with the `Co-Authored-By` trailer.

Push to `origin main`. If the push is rejected, pull, resolve, and say what happened — never
force.

## 6. Report

Close with, briefly:

- what the task changed, and the numbers behind any claim it makes
- the test result and the commit hash
- anything the work turned up that is not yet on the backlog
- **the next unchecked task**, named, so the user can decide whether to run `/continue` again

## When to stop and ask instead

- The task as written turns out to rest on a wrong premise — say so and propose the correction
  before building on it.
- The corpus does not settle a design question the task depends on, and the alternatives lead to
  materially different work.
- Finishing would need writing to one of the user's real game projects. Never do that — copy the
  project into the scratchpad first, and if that is not viable, ask.
