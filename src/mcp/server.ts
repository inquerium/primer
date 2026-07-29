import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools.ts';
import { createSurfaceServer } from '../surface/server.ts';
import { db, dbPath, one } from '../db/index.ts';
import { loadCurriculum } from '../curriculum/load.ts';
import { TUTOR_PROMPT } from './prompt.ts';

const VERSION = '0.1.0';

export async function startMcpServer(): Promise<void> {
  db(); // create/migrate the record before anything can ask for it

  // A fresh install connects Claude before anyone runs `primer init`. An empty
  // skill table would mean a tutor with nothing to teach and no way to say why.
  const skills = one<{ n: number }>(`SELECT count(*) AS n FROM skill`)?.n ?? 0;
  if (skills === 0) {
    const loaded = loadCurriculum();
    process.stderr.write(`primer: loaded ${loaded.skills} skills on first run\n`);
  }

  const surface = await createSurfaceServer();
  try {
    await surface.listen();
  } catch (err) {
    // Another primer process already owns the port — reuse it rather than dying.
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    process.stderr.write(`primer: surface already running on ${surface.origin}\n`);
  }

  const ctx: ToolContext = { origin: surface.origin };

  const server = new Server(
    { name: 'primer', version: VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS_BY_NAME.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool "${request.params.name}"` }],
      };
    }
    try {
      const result = tool.handler(request.params.arguments ?? {}, ctx);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${(err as Error).message}` }],
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'tutor',
        description:
          'How to run a session with this record: read the whole child first, build the ' +
          'interface for them, write back what you learned.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'tutor') throw new Error(`Unknown prompt "${request.params.name}"`);
    return {
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: TUTOR_PROMPT } },
      ],
    };
  });

  process.stderr.write(
    `primer ${VERSION} — record: ${dbPath()} — surface: ${surface.origin}\n`,
  );

  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] && /server\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  startMcpServer().catch((err) => {
    process.stderr.write(`primer: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
