import { z } from 'zod';

export const TilesetSchema = z.object({
  id: z.number(),
  flags: z.array(z.number()),
  mode: z.number(),
  name: z.string(),
  note: z.string(),
  tilesetNames: z.array(z.string()),
});

export type Tileset = z.infer<typeof TilesetSchema>;
