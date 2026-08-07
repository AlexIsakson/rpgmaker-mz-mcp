import path from 'node:path';
import { FileHandler } from './file-handler.js';
import { TilesetSchema, type Tileset } from '../schemas/tileset.js';

/**
 * Reads passability/terrain flags for a tileset from Tilesets.json.
 * `flags[tileId]` is a bitmask — see core/map-grid.ts for the bit layout.
 */
export class TilesetReader {
  static async get(dataPath: string, tilesetId: number): Promise<Tileset> {
    const raw = await FileHandler.readJsonRaw(path.join(dataPath, 'Tilesets.json'));
    const tilesets = raw as unknown[];
    const entry = tilesets[tilesetId];
    if (!entry) {
      throw new Error(`Tileset ID ${tilesetId} not found in Tilesets.json.`);
    }
    return TilesetSchema.parse(entry);
  }

  static async getFlags(dataPath: string, tilesetId: number): Promise<number[]> {
    return (await TilesetReader.get(dataPath, tilesetId)).flags;
  }
}
