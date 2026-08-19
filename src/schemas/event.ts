import { z } from 'zod';
import {
  resolveBattleDesignation,
  resolveTransferDesignation,
} from '../core/designation.js';

export const EventCommandSchema = z.object({
  code: z.number(),
  indent: z.number(),
  parameters: z.array(z.unknown()),
});

export const EventPageConditionSchema = z.object({
  actorId: z.number(),
  actorValid: z.boolean(),
  itemId: z.number(),
  itemValid: z.boolean(),
  selfSwitchCh: z.string(),
  selfSwitchValid: z.boolean(),
  switch1Id: z.number(),
  switch1Valid: z.boolean(),
  switch2Id: z.number(),
  switch2Valid: z.boolean(),
  variableId: z.number(),
  variableValid: z.boolean(),
  variableValue: z.number(),
});

export const EventPageImageSchema = z.object({
  characterIndex: z.number(),
  characterName: z.string(),
  direction: z.number(),
  pattern: z.number(),
  tileId: z.number(),
});

export const MoveRouteSchema = z.object({
  list: z.array(z.object({
    code: z.number(),
    parameters: z.array(z.unknown()).optional(),
  })),
  repeat: z.boolean(),
  skippable: z.boolean(),
  wait: z.boolean(),
});

export const EventPageSchema = z.object({
  conditions: EventPageConditionSchema,
  directionFix: z.boolean(),
  image: EventPageImageSchema,
  list: z.array(EventCommandSchema),
  moveFrequency: z.number(),
  moveRoute: MoveRouteSchema,
  moveSpeed: z.number(),
  moveType: z.number(),
  priorityType: z.number(),
  stepAnime: z.boolean(),
  through: z.boolean(),
  trigger: z.number(),
  walkAnime: z.boolean(),
});

export const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string(),
  pages: z.array(EventPageSchema),
  x: z.number(),
  y: z.number(),
});

export type EventCommand = z.infer<typeof EventCommandSchema>;
export type EventPageCondition = z.infer<typeof EventPageConditionSchema>;
export type EventPage = z.infer<typeof EventPageSchema>;
export type Event = z.infer<typeof EventSchema>;

// --- Human-readable command types → RPG Maker MZ command codes ---

export const COMMAND_CODES: Record<string, number> = {
  // Message
  show_text: 101,
  show_text_body: 401,
  show_choices: 102,
  when_choice: 402,
  when_cancel: 403,
  input_number: 103,
  select_item: 104,
  show_scrolling_text: 105,
  show_scrolling_text_body: 405,

  // Game Progression
  control_switches: 121,
  control_variables: 122,
  control_self_switch: 123,
  control_timer: 124,

  // Flow Control
  conditional_branch: 111,
  else: 411,
  end_branch: 412,
  loop: 112,
  repeat_above: 413,
  break_loop: 113,
  end_choices: 404,
  if_win: 601,
  if_escape: 602,
  if_lose: 603,
  end_battle: 604,
  exit_event: 115,
  common_event: 117,
  label: 118,
  jump_to_label: 119,
  comment: 108,
  comment_body: 408,

  // Party
  change_gold: 125,
  change_items: 126,
  change_weapons: 127,
  change_armors: 128,
  change_party_member: 129,

  // Actor
  change_hp: 311,
  change_mp: 312,
  change_tp: 326,
  change_state: 313,
  recover_all: 314,
  change_exp: 315,
  change_level: 316,
  change_parameter: 317,
  change_skill: 318,
  change_equipment: 319,
  change_name: 320,
  change_class: 321,
  change_nickname: 324,
  change_profile: 325,

  // Movement
  transfer_player: 201,
  set_vehicle_location: 202,
  set_event_location: 203,
  scroll_map: 204,
  set_movement_route: 205,
  get_on_off_vehicle: 206,

  // Character
  change_transparency: 211,
  show_animation: 212,
  show_balloon_icon: 213,
  erase_event: 214,
  change_player_followers: 216,
  gather_followers: 217,

  // Screen
  fadeout_screen: 221,
  fadein_screen: 222,
  tint_screen: 223,
  flash_screen: 224,
  shake_screen: 225,

  // Timing
  wait: 230,

  // Picture
  show_picture: 231,
  move_picture: 232,
  rotate_picture: 233,
  tint_picture: 234,
  erase_picture: 235,

  // Audio
  play_bgm: 241,
  fadeout_bgm: 242,
  save_bgm: 243,
  resume_bgm: 244,
  play_bgs: 245,
  fadeout_bgs: 246,
  play_me: 249,
  play_se: 250,
  stop_se: 251,

  // Scene Control
  battle_processing: 301,
  shop_processing: 302,
  name_input_processing: 303,
  open_menu: 351,
  open_save: 352,
  game_over: 353,
  return_to_title: 354,

  // System
  change_battle_bgm: 132,
  change_victory_me: 133,
  change_defeat_me: 139,
  change_vehicle_bgm: 140,

  // Map
  change_tileset: 282,
  change_battle_back: 283,
  change_parallax: 284,

  // Plugin
  plugin_command: 356,

  // End of list marker
  end: 0,
};

/**
 * `command122`'s `params[4]` onward — shaped entirely by `operand`
 * (`params[3]`), from `Game_Interpreter.prototype.command122` /
 * `gameDataOperand` (byte-identical v1.4.4 through v1.9.0):
 *
 * ```js
 * switch (operand) {
 *   case 0: value = params[4]; break;                                   // Constant
 *   case 1: value = $gameVariables.value(params[4]); break;             // Variable
 *   case 2: value = params[4]; randomMax = params[5] - params[4] + 1;   // Random
 *           randomMax = Math.max(randomMax, 1); break;
 *   case 3: value = this.gameDataOperand(params[4], params[5], params[6]); break; // Game Data
 *   case 4: value = eval(params[4]); break;                             // Script
 * }
 * ```
 *
 * Every operand but Constant used to collapse onto the same single `value`
 * field, which is how Random broke: `params[5]` was never emitted, so
 * `randomMax` computed `undefined - value + 1`, which is `NaN`, and every
 * variable in range was set to `NaN`. Each operand now has its own field(s)
 * and is refused by name if they are missing, rather than emitting a
 * `params` array command122 reads as a silently wrong value.
 */
function controlVariableOperand(cmd: Record<string, unknown>, operand: number): unknown[] {
  switch (operand) {
    case 0: // Constant
      return [(cmd.value as number) || 0];

    case 1: { // Variable — $gameVariables.value(params[4])
      const sourceVariableId = cmd.sourceVariableId;
      if (typeof sourceVariableId !== 'number') {
        throw new Error(
          'control_variables with operand 1 (Variable) needs sourceVariableId — the id of the ' +
            'variable command122 reads the new value from.'
        );
      }
      return [sourceVariableId];
    }

    case 2: { // Random — params[4] is the low end, params[5] the high end
      const min = (cmd.value as number) || 0;
      const max = cmd.randomMax;
      if (typeof max !== 'number') {
        throw new Error(
          'control_variables with operand 2 (Random) needs randomMax — command122 computes ' +
            '`randomMax = params[5] - params[4] + 1`, and a missing params[5] makes that NaN, ' +
            'setting every variable in range to NaN. value is the low end, randomMax the high ' +
            'end, both inclusive.'
        );
      }
      return [min, max];
    }

    case 3: { // Game Data — gameDataOperand(type, param1, param2)
      const gameDataType = cmd.gameDataType;
      if (typeof gameDataType !== 'number') {
        throw new Error(
          'control_variables with operand 3 (Game Data) needs gameDataType — see ' +
            'Game_Interpreter.gameDataOperand for what each type reads: 0 item, 1 weapon, ' +
            '2 armor, 3 actor, 4 enemy, 5 character, 6 party, 7 other, 8 last action. ' +
            'gameDataParam1/gameDataParam2 refine it (an actor id and a stat, a map id, and so ' +
            'on) and default to 0.'
        );
      }
      const param1 = (cmd.gameDataParam1 as number) || 0;
      const param2 = (cmd.gameDataParam2 as number) || 0;
      return [gameDataType, param1, param2];
    }

    case 4: { // Script — eval(params[4])
      const script = cmd.script;
      if (typeof script !== 'string' || script.trim() === '') {
        throw new Error(
          'control_variables with operand 4 (Script) needs a non-empty script string — ' +
            'command122 evals it verbatim as the new value.'
        );
      }
      return [script];
    }

    default:
      throw new Error(
        `control_variables operand ${operand} is not 0-4 (Constant, Variable, Random, Game ` +
          'Data, Script) — command122 has no case for it, so every variable in range would ' +
          'silently be set to 0.'
      );
  }
}

/**
 * Convert human-readable command to RPG Maker MZ event commands.
 */
export function convertCommand(cmd: {
  type: string;
  [key: string]: unknown;
}): EventCommand[] {
  switch (cmd.type) {
    case 'show_text': {
      const face = (cmd.face as string) || '';
      const faceIndex = (cmd.faceIndex as number) || 0;
      const background = (cmd.background as number) || 0;
      const positionType = (cmd.positionType as number) || 2;
      const text = (cmd.text as string) || '';
      const lines = text.split('\n');
      // RPG Maker MZ message window shows max 4 lines per box
      const result: EventCommand[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (i % 4 === 0) {
          result.push({ code: 101, indent: 0, parameters: [face, faceIndex, background, positionType] });
        }
        result.push({ code: 401, indent: 0, parameters: [lines[i]] });
      }
      return result;
    }

    case 'show_choices': {
      const choices = (cmd.choices as string[]) || [];
      const cancelType = (cmd.cancelType as number) ?? -2;
      const defaultType = (cmd.defaultType as number) ?? 0;
      return [
        { code: 102, indent: 0, parameters: [choices, cancelType, defaultType, 2, 0] },
      ];
    }

    case 'transfer_player': {
      // One designation flag covers map, x and y together — there is no mixed
      // mode. See src/core/designation.ts.
      const { designation, operands } = resolveTransferDesignation(cmd, 0);
      const direction = (cmd.direction as number) || 0;
      const fadeType = (cmd.fadeType as number) || 0;
      return [
        { code: 201, indent: 0, parameters: [designation, ...operands, direction, fadeType] },
      ];
    }

    case 'control_switches': {
      const startId = (cmd.startId as number) || 1;
      const endId = (cmd.endId as number) || startId;
      const value = (cmd.value as number) ?? 0; // 0=ON, 1=OFF
      return [
        { code: 121, indent: 0, parameters: [startId, endId, value] },
      ];
    }

    case 'control_variables': {
      const startId = (cmd.startId as number) || 1;
      const endId = (cmd.endId as number) || startId;
      const operationType = (cmd.operationType as number) || 0;
      const operand = (cmd.operand as number) || 0;
      return [
        {
          code: 122,
          indent: 0,
          parameters: [startId, endId, operationType, operand, ...controlVariableOperand(cmd, operand)],
        },
      ];
    }

    case 'control_self_switch': {
      const key = (cmd.key as string) || 'A';
      const value = (cmd.value as number) ?? 0;
      return [
        { code: 123, indent: 0, parameters: [key, value] },
      ];
    }

    case 'conditional_branch': {
      const conditionType = (cmd.conditionType as number) || 0;
      const param1 = (cmd.param1 as number) || 0;
      const param2 = (cmd.param2 as number) || 0;
      const parameters: unknown[] = [conditionType, param1, param2];
      // A variable comparison (type 1) reads two more parameters: what to
      // compare against and which comparison to use. command111 does
      // `switch (params[4])` and falls through every case when it is undefined,
      // leaving result false — so a three-parameter variable branch can never be
      // taken. Emit the pair, defaulting to "== 0".
      if (conditionType === 1 || cmd.param3 !== undefined || cmd.param4 !== undefined) {
        parameters.push((cmd.param3 as number) ?? 0, (cmd.param4 as number) ?? 0);
      }
      return [
        { code: 111, indent: 0, parameters },
      ];
    }

    case 'common_event': {
      const eventId = (cmd.eventId as number) || 1;
      return [
        { code: 117, indent: 0, parameters: [eventId] },
      ];
    }

    case 'change_gold': {
      const operation = (cmd.operation as number) || 0; // 0=increase, 1=decrease
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 0;
      return [
        { code: 125, indent: 0, parameters: [operation, operandType, value] },
      ];
    }

    case 'change_items': {
      const itemId = (cmd.itemId as number) || 1;
      const operation = (cmd.operation as number) || 0;
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 1;
      return [
        { code: 126, indent: 0, parameters: [itemId, operation, operandType, value] },
      ];
    }

    case 'play_bgm': {
      const name = (cmd.name as string) || '';
      const volume = (cmd.volume as number) ?? 90;
      const pitch = (cmd.pitch as number) ?? 100;
      const pan = (cmd.pan as number) ?? 0;
      return [
        { code: 241, indent: 0, parameters: [{ name, volume, pitch, pan }] },
      ];
    }

    case 'play_se': {
      const name = (cmd.name as string) || '';
      const volume = (cmd.volume as number) ?? 90;
      const pitch = (cmd.pitch as number) ?? 100;
      const pan = (cmd.pan as number) ?? 0;
      return [
        { code: 250, indent: 0, parameters: [{ name, volume, pitch, pan }] },
      ];
    }

    case 'wait': {
      const duration = (cmd.duration as number) || 60;
      return [
        { code: 230, indent: 0, parameters: [duration] },
      ];
    }

    case 'fadeout_screen':
      return [{ code: 221, indent: 0, parameters: [] }];

    case 'fadein_screen':
      return [{ code: 222, indent: 0, parameters: [] }];

    case 'erase_event':
      return [{ code: 214, indent: 0, parameters: [] }];

    case 'recover_all': {
      const actorId = (cmd.actorId as number) || 0; // 0 = entire party
      return [
        { code: 314, indent: 0, parameters: [0, actorId] },
      ];
    }

    case 'battle_processing': {
      // params[0] is the designation and it decides what params[1] means —
      // a troop id, a variable holding one, or nothing at all. See
      // src/core/designation.ts.
      const { designation, operand } = resolveBattleDesignation(cmd, 0);
      const canEscape = (cmd.canEscape as boolean) ?? true;
      const canLose = (cmd.canLose as boolean) ?? false;
      return [
        { code: 301, indent: 0, parameters: [designation, operand, canEscape, canLose] },
      ];
    }

    case 'shop_processing': {
      // A row is [kind, dataId] or [kind, dataId, price]. Without a price the
      // row uses price type 0, which Window_ShopBuy reads as "charge whatever
      // the database says"; with one it uses type 1 and the price field.
      const goods = (cmd.goods as [number, number, number?][]) || [];
      const purchaseOnly = (cmd.purchaseOnly as boolean) ?? false;

      // No goods used to emit a shop selling item id 1 — a real window offering
      // whatever happens to be first in the database, with nothing to say it was
      // never asked for.
      if (goods.length === 0) {
        throw new Error(
          'shop_processing needs at least one row of goods, each [kind, dataId] or ' +
            '[kind, dataId, price] where kind is 0 item, 1 weapon, 2 armor.'
        );
      }

      const row = (g: [number, number, number?]): number[] =>
        g[2] === undefined ? [g[0], g[1], 0, 0] : [g[0], g[1], 1, g[2]];

      // command302 takes its own parameters as the first row and reads
      // params[4] as the shop-wide purchaseOnly flag.
      return [
        { code: 302, indent: 0, parameters: [...row(goods[0]), purchaseOnly] },
        ...goods.slice(1).map((g) => ({ code: 605, indent: 0, parameters: row(g) })),
      ];
    }

    case 'change_hp': {
      const actorId = (cmd.actorId as number) || 1;
      const operation = (cmd.operation as number) || 0;
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 0;
      const allowDeath = (cmd.allowDeath as boolean) ?? false;
      return [
        { code: 311, indent: 0, parameters: [0, actorId, operation, operandType, value, allowDeath] },
      ];
    }

    case 'change_exp': {
      const actorId = (cmd.actorId as number) || 0;
      const operation = (cmd.operation as number) || 0;
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 0;
      const showLevelUp = (cmd.showLevelUp as boolean) ?? true;
      return [
        { code: 315, indent: 0, parameters: [0, actorId, operation, operandType, value, showLevelUp] },
      ];
    }

    case 'comment': {
      const text = (cmd.text as string) || '';
      const lines = text.split('\n');
      return [
        { code: 108, indent: 0, parameters: [lines[0] || ''] },
        ...lines.slice(1).map((line) => ({
          code: 408, indent: 0, parameters: [line],
        })),
      ];
    }

    case 'label': {
      const name = (cmd.name as string) || '';
      return [{ code: 118, indent: 0, parameters: [name] }];
    }

    case 'jump_to_label': {
      const name = (cmd.name as string) || '';
      return [{ code: 119, indent: 0, parameters: [name] }];
    }

    case 'loop':
      return [{ code: 112, indent: 0, parameters: [] }];

    case 'break_loop':
      return [{ code: 113, indent: 0, parameters: [] }];

    // Block markers. The engine has no command412 or command404 method at all,
    // so both are pure structure: what ends a block is the indent of the
    // commands after it, and these are what the editor draws that boundary as.
    case 'else':
      return [{ code: 411, indent: 0, parameters: [] }];

    case 'end_branch':
      return [{ code: 412, indent: 0, parameters: [] }];

    case 'repeat_above':
      return [{ code: 413, indent: 0, parameters: [] }];

    case 'end_choices':
      return [{ code: 404, indent: 0, parameters: [] }];

    case 'when_choice': {
      // command402 compares params[0] against the stored choice index; the
      // editor keeps the label alongside it, which describeCommands reads back.
      const index = (cmd.index as number) ?? 0;
      const label = cmd.label as string | undefined;
      return [{
        code: 402,
        indent: 0,
        parameters: label === undefined ? [index] : [index, label],
      }];
    }

    case 'when_cancel':
      return [{ code: 403, indent: 0, parameters: [] }];

    // Battle result arms. BattleManager.endBattle passes 0 win, 1 escape,
    // 2 lose to the callback command301 installed, and command601/602/603 each
    // skipBranch unless _branch[_indent] matches. 604 has no method at all.
    case 'if_win':
      return [{ code: 601, indent: 0, parameters: [] }];

    case 'if_escape':
      return [{ code: 602, indent: 0, parameters: [] }];

    case 'if_lose':
      return [{ code: 603, indent: 0, parameters: [] }];

    case 'end_battle':
      return [{ code: 604, indent: 0, parameters: [] }];

    /** The blank line the editor leaves at the end of every block body. */
    case 'blank':
      return [{ code: 0, indent: 0, parameters: [] }];

    case 'exit_event':
      return [{ code: 115, indent: 0, parameters: [] }];

    case 'game_over':
      return [{ code: 353, indent: 0, parameters: [] }];

    case 'return_to_title':
      return [{ code: 354, indent: 0, parameters: [] }];

    case 'change_party_member': {
      const actorId = (cmd.actorId as number) || 1;
      const operation = (cmd.operation as number) || 0; // 0=add, 1=remove
      const initialize = (cmd.initialize as boolean) ?? true;
      return [
        { code: 129, indent: 0, parameters: [actorId, operation, initialize] },
      ];
    }

    case 'change_class': {
      const actorId = (cmd.actorId as number) || 1;
      const classId = (cmd.classId as number) || 1;
      const keepExp = (cmd.keepExp as boolean) ?? false;
      return [
        { code: 321, indent: 0, parameters: [actorId, classId, keepExp] },
      ];
    }

    case 'change_skill': {
      const actorId = (cmd.actorId as number) || 1;
      const operation = (cmd.operation as number) || 0; // 0=learn, 1=forget
      const skillId = (cmd.skillId as number) || 1;
      return [
        { code: 318, indent: 0, parameters: [0, actorId, operation, skillId] },
      ];
    }

    case 'change_level': {
      const actorId = (cmd.actorId as number) || 0;
      const operation = (cmd.operation as number) || 0; // 0=increase, 1=decrease
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 1;
      const showLevelUp = (cmd.showLevelUp as boolean) ?? true;
      return [
        { code: 316, indent: 0, parameters: [0, actorId, operation, operandType, value, showLevelUp] },
      ];
    }

    case 'change_state': {
      const actorId = (cmd.actorId as number) || 0;
      const operation = (cmd.operation as number) || 0; // 0=add, 1=remove
      const stateId = (cmd.stateId as number) || 1;
      return [
        { code: 313, indent: 0, parameters: [0, actorId, operation, stateId] },
      ];
    }

    case 'change_name': {
      const actorId = (cmd.actorId as number) || 1;
      const name = (cmd.name as string) || '';
      return [
        { code: 320, indent: 0, parameters: [actorId, name] },
      ];
    }

    case 'change_weapons': {
      const weaponId = (cmd.weaponId as number) || 1;
      const operation = (cmd.operation as number) || 0;
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 1;
      return [
        { code: 127, indent: 0, parameters: [weaponId, operation, operandType, value] },
      ];
    }

    case 'change_armors': {
      const armorId = (cmd.armorId as number) || 1;
      const operation = (cmd.operation as number) || 0;
      const operandType = (cmd.operandType as number) || 0;
      const value = (cmd.value as number) || 1;
      return [
        { code: 128, indent: 0, parameters: [armorId, operation, operandType, value] },
      ];
    }

    case 'show_balloon_icon': {
      const characterId = (cmd.characterId as number) ?? -1; // -1=player, 0=this event
      const balloonId = (cmd.balloonId as number) || 1; // 1=exclamation, 2=question, etc.
      const waitForCompletion = (cmd.waitForCompletion as boolean) ?? false;
      return [
        { code: 213, indent: 0, parameters: [characterId, balloonId, waitForCompletion] },
      ];
    }

    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}
