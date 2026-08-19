import assert from "node:assert/strict";
import { test } from "node:test";

import { createMcpToolset, mcpToolName } from "../src/mcp-client.js";

// A stand-in for an MCP SDK Client. connectMcpClient is injected so no real
// server process is ever spawned in tests.
/**
 * @param {{ tools: any[], callResult?: any, failOnConnect?: boolean, failOnCall?: boolean }} config
 */
function fakeClient({ tools, callResult, failOnConnect = false, failOnCall = false }) {
  return {
    connected: false,
    closed: false,
    async connect() {
      if (failOnConnect) throw new Error("server not found");
      this.connected = true;
    },
    async listTools() {
      return { tools };
    },
    async callTool({ name, arguments: args }) {
      if (failOnCall) throw new Error("tool exploded");
      return callResult ?? { content: [{ type: "text", text: `called ${name} with ${JSON.stringify(args)}` }] };
    },
    async close() {
      this.closed = true;
    },
  };
}

const NOTION_TOOLS = [
  { name: "search", description: "Search the workspace", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "fetch", description: "Fetch a page", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
];

test("mcpToolName namespaces a tool under its server", () => {
  assert.equal(mcpToolName("notion", "search"), "kb__notion__search");
  // Characters illegal in an OpenAI tool name are normalized away.
  assert.equal(mcpToolName("my notion!", "search-pages"), "kb__my_notion__search_pages");
});

test("discovers tools from every configured server and namespaces them", async () => {
  const toolset = createMcpToolset({
    servers: [
      { name: "notion", command: "notion-mcp" },
      { name: "drive", url: "https://example.test/mcp" },
    ],
    connectMcpClient: async (server) =>
      fakeClient({ tools: server.name === "notion" ? NOTION_TOOLS : [{ name: "list_files", description: "List", inputSchema: { type: "object" } }] }),
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await toolset.connect();
  const names = toolset.listToolNames().sort();

  assert.deepEqual(names, ["kb__drive__list_files", "kb__notion__fetch", "kb__notion__search"]);
  assert.deepEqual(toolset.listServerStatus(), [
    { name: "notion", ok: true, toolCount: 2, error: null },
    { name: "drive", ok: true, toolCount: 1, error: null },
  ]);
});

test("a server that fails to connect is reported but does not break the others", async () => {
  const toolset = createMcpToolset({
    servers: [
      { name: "broken", command: "nope" },
      { name: "notion", command: "notion-mcp" },
    ],
    connectMcpClient: async (server) =>
      fakeClient({ tools: NOTION_TOOLS, failOnConnect: server.name === "broken" }),
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await toolset.connect();

  assert.deepEqual(toolset.listToolNames().sort(), ["kb__notion__fetch", "kb__notion__search"]);
  const status = toolset.listServerStatus();
  assert.equal(status[0].ok, false);
  assert.match(status[0].error, /server not found/);
  assert.equal(status[1].ok, true);
});

test("callTool routes to the right server and flattens the text content", async () => {
  const toolset = createMcpToolset({
    servers: [{ name: "notion", command: "notion-mcp" }],
    connectMcpClient: async () => fakeClient({ tools: NOTION_TOOLS }),
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });
  await toolset.connect();

  const result = await toolset.callTool("kb__notion__search", { query: "pricing" });
  assert.match(result, /called search/);
  assert.match(result, /pricing/);
  // Results are labelled as untrusted reference data, never as instructions.
  assert.match(result, /BEGIN MCP RESULT/);
  assert.match(result, /END MCP RESULT/);
});

test("a failing tool call returns an error string rather than throwing", async () => {
  const toolset = createMcpToolset({
    servers: [{ name: "notion", command: "notion-mcp" }],
    connectMcpClient: async () => fakeClient({ tools: NOTION_TOOLS, failOnCall: true }),
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });
  await toolset.connect();

  const result = await toolset.callTool("kb__notion__search", { query: "x" });
  assert.match(result, /tool exploded/);
});

test("calling an unknown tool returns a clear error string", async () => {
  const toolset = createMcpToolset({ servers: [], connectMcpClient: async () => fakeClient({ tools: [] }) });
  await toolset.connect();
  assert.match(await toolset.callTool("kb__nope__nope", {}), /not available/i);
});

test("no configured servers means no connections and no tools", async () => {
  let connectCalls = 0;
  const toolset = createMcpToolset({
    servers: [],
    connectMcpClient: async () => {
      connectCalls += 1;
      return fakeClient({ tools: [] });
    },
  });

  await toolset.connect();
  assert.equal(connectCalls, 0);
  assert.deepEqual(toolset.listToolNames(), []);
  assert.equal(toolset.isConfigured(), false);
});

test("close shuts down every connected client", async () => {
  const clients = [];
  const toolset = createMcpToolset({
    servers: [{ name: "notion", command: "notion-mcp" }],
    connectMcpClient: async () => {
      const client = fakeClient({ tools: NOTION_TOOLS });
      clients.push(client);
      return client;
    },
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await toolset.connect();
  await toolset.close();

  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);
  assert.deepEqual(toolset.listToolNames(), []);
});
