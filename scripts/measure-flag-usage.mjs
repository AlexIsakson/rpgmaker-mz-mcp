// Counts how event logic actually refers to global switches and variables, and
// how often those ids carry a name in System.json.
//
//   node scripts/measure-flag-usage.mjs [projectDataDir...]
//
// This is the evidence behind "Naming a flag in a command list" in ROADMAP.md
// and behind which command types `src/core/command-flags.ts` accepts a name for.
// The question it answers is narrow: is the *name* the handle a real project
// works in, or is it decoration on top of the id? Re-run it before widening the
// set of commands that take a `switchName`.
//
// Unlike build-passage-catalogue.mjs this generates nothing — it prints counts.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOTS = [
  ['samplemaps', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/samplemaps'],
  ['newdata', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/newdata/data'],
  ['Wicked Heart', 'M:/Projects/RPGMZ/Wicked Heart/data'],
  ['Foo', 'M:/Projects/RPGMZ/Foo/data'],
  ['Learn', 'M:/Projects/RPGMZ/Learn/data'],
];

const args = process.argv.slice(2);
const roots = args.length > 0 ? args.map((d) => [path.basename(path.dirname(d)) || d, d]) : DEFAULT_ROOTS;

/** Codes that carry a global switch or variable id, per Game_Interpreter. */
function scanList(list, tally) {
  if (!Array.isArray(list)) return;
  for (const cmd of list) {
    const p = cmd?.parameters ?? [];
    switch (cmd?.code) {
      // command121 loops params[0]..params[1] through Game_Switches.setValue.
      case 121:
        tally.control121++;
        for (let id = p[0]; id <= p[1]; id++) tally.switchIds.add(id);
        break;
      // command122 loops params[0]..params[1]; operand 1 reads params[4] too.
      case 122:
        tally.control122++;
        for (let id = p[0]; id <= p[1]; id++) tally.variableIds.add(id);
        if (p[3] === 1) { tally.varOperand++; tally.variableIds.add(p[4]); }
        break;
      // command111 reads params[1] as a switch id on type 0, a variable id on
      // type 1, and as something else entirely on every other type.
      case 111:
        if (p[0] === 0) { tally.branchSwitch++; tally.switchIds.add(p[1]); }
        else if (p[0] === 1) { tally.branchVariable++; tally.variableIds.add(p[1]); }
        else tally.branchOther++;
        break;
      case 103: tally.inputNumber++; tally.variableIds.add(p[0]); break;
      case 104: tally.selectItem++; tally.variableIds.add(p[0]); break;
      default: break;
    }
  }
}

function blankTally() {
  return {
    maps: 0,
    control121: 0, control122: 0, varOperand: 0,
    branchSwitch: 0, branchVariable: 0, branchOther: 0,
    inputNumber: 0, selectItem: 0,
    pageSwitch: 0, pageVariable: 0, pageSelfSwitch: 0,
    commonEventTrigger: 0,
    switchIds: new Set(), variableIds: new Set(),
  };
}

for (const [label, dir] of roots) {
  if (!fs.existsSync(dir)) { console.log(`(missing) ${label} — ${dir}\n`); continue; }
  const tally = blankTally();

  for (const file of fs.readdirSync(dir)) {
    if (!/\.json$/i.test(file)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }

    if (/^Map\d+\.json$/i.test(file)) {
      tally.maps++;
      for (const event of data.events ?? []) {
        for (const page of event?.pages ?? []) {
          const c = page.conditions ?? {};
          if (c.switch1Valid) { tally.pageSwitch++; tally.switchIds.add(c.switch1Id); }
          if (c.switch2Valid) { tally.pageSwitch++; tally.switchIds.add(c.switch2Id); }
          if (c.variableValid) { tally.pageVariable++; tally.variableIds.add(c.variableId); }
          if (c.selfSwitchValid) tally.pageSelfSwitch++;
          scanList(page.list, tally);
        }
      }
    } else if (/^CommonEvents\.json$/i.test(file)) {
      for (const ce of data ?? []) {
        if (!ce) continue;
        if (ce.switchId) { tally.commonEventTrigger++; tally.switchIds.add(ce.switchId); }
        scanList(ce.list, tally);
      }
    } else if (/^Troops\.json$/i.test(file)) {
      for (const troop of data ?? []) for (const page of troop?.pages ?? []) scanList(page.list, tally);
    }
  }

  const systemPath = path.join(dir, 'System.json');
  const system = fs.existsSync(systemPath)
    ? JSON.parse(fs.readFileSync(systemPath, 'utf8'))
    : null;
  const named = (arr, ids) => (arr ? [...ids].filter((id) => arr[id]?.trim()).length : null);
  const namedTotal = (arr) => (arr ? arr.filter((n) => n?.trim()).length : null);

  console.log(`${label}  (${tally.maps} map file(s))`);
  console.log(`  121 control switches ......... ${tally.control121}`);
  console.log(`  111 branch on a switch ....... ${tally.branchSwitch}`);
  console.log(`  page condition on a switch ... ${tally.pageSwitch}`);
  console.log(`  common event trigger switch .. ${tally.commonEventTrigger}`);
  console.log(`  122 control variables ........ ${tally.control122} (${tally.varOperand} reading a variable)`);
  console.log(`  111 branch on a variable ..... ${tally.branchVariable}`);
  console.log(`  page condition on a variable . ${tally.pageVariable}`);
  console.log(`  111 branch on anything else .. ${tally.branchOther}`);
  console.log(`  103/104 into a variable ...... ${tally.inputNumber}/${tally.selectItem}`);
  console.log(`  page condition self-switch ... ${tally.pageSelfSwitch}  (no allocation — Game_SelfSwitches is unbounded)`);

  if (system) {
    console.log(
      `  switch ids referenced: ${tally.switchIds.size}, named in System.json: ` +
      `${named(system.switches, tally.switchIds)} (array reaches ${system.switches.length - 1}, ` +
      `${namedTotal(system.switches)} named in all)`
    );
    console.log(
      `  variable ids referenced: ${tally.variableIds.size}, named: ` +
      `${named(system.variables, tally.variableIds)} (array reaches ${system.variables.length - 1}, ` +
      `${namedTotal(system.variables)} named in all)`
    );
  } else {
    console.log(`  switch ids referenced: ${tally.switchIds.size}, variable ids: ${tally.variableIds.size} (no System.json here)`);
  }
  console.log('');
}
