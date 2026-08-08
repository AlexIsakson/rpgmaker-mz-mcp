#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerDatabaseTools } from './tools/database-tools.js';
import { registerMapTools } from './tools/map-tools.js';
import { registerMapGridTools } from './tools/map-grid-tools.js';
import { registerMapGraphTools } from './tools/map-graph-tools.js';
import { registerMapPaintTools } from './tools/map-paint-tools.js';
import { registerBlueprintTools } from './tools/blueprint-tools.js';
import { registerPropTools } from './tools/prop-tools.js';
import { registerTowngenTools } from './tools/towngen-tools.js';
import { registerInteriorTools } from './tools/interior-tools.js';
import { registerNpcTools } from './tools/npc-tools.js';
import { registerDungeonDressingTools } from './tools/dungeon-dressing-tools.js';
import { registerMapgenTools } from './tools/mapgen-tools.js';
import { registerConsistencyTools } from './tools/consistency-tools.js';
import { registerEventTools } from './tools/event-tools.js';
import { registerEventFlowTools } from './tools/event-flow-tools.js';
import { registerScenarioTools } from './tools/scenario-tools.js';
import { registerTilesetTools } from './tools/tileset-tools.js';
import { registerWalkabilityTools } from './tools/walkability-tools.js';

async function main(): Promise<void> {
  logger.info('Starting RPG Maker MZ MCP Server...');

  const server = new McpServer({
    name: 'rpgmaker-mz',
    version: '1.0.0',
  });

  // Register all tool groups
  registerProjectTools(server);
  registerDatabaseTools(server);
  registerMapTools(server);
  registerMapGridTools(server);
  registerMapGraphTools(server);
  registerMapPaintTools(server);
  registerBlueprintTools(server);
  registerPropTools(server);
  registerTowngenTools(server);
  registerInteriorTools(server);
  registerNpcTools(server);
  registerDungeonDressingTools(server);
  registerMapgenTools(server);
  registerConsistencyTools(server);
  registerEventTools(server);
  registerEventFlowTools(server);
  registerScenarioTools(server);
  registerTilesetTools(server);
  registerWalkabilityTools(server);

  logger.info('All tools registered');

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP Server connected via stdio');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
