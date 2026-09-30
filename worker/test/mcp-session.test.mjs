// End-to-end session binding tests. wrangler builds the harness entry and
// runs it in local workerd (as `wrangler dev` does), so these exercise the
// pinned agents and partyserver session routing, the real YnabMCP Durable
// Object, and the production /mcp and /sse handlers. OAuthProvider is
// replaced by a header naming the grant props, and YNAB by an outbound stub
// that resolves each access token to its user; no live credentials are used.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

// Keep the local runtime offline: no Wrangler telemetry from test runs.
process.env.WRANGLER_SEND_METRICS = "false";

const WORKER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = "https://ynab.tycho.nz";

const ALICE = { ynabUserId: "alice-ynab-id", writesEnabled: true };
const ALICE_READ_ONLY = { ynabUserId: "alice-ynab-id", writesEnabled: false };
const BOB = { ynabUserId: "bob-ynab-id", writesEnabled: true };
const ACCESS_TOKENS = new Map([
  ["alice-access-token", "alice-ynab-id"],
  ["bob-access-token", "bob-ynab-id"],
]);

let persistDir;
let worker;

// YNAB API stand-in: GET /v1/user answers with the token owner's id.
function ynabStub(request) {
  const url = new URL(request.url);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  const userId = ACCESS_TOKENS.get(token);
  if (url.hostname !== "api.ynab.com" || !userId) {
    return Response.json({ error: { id: "401", name: "unauthorized" } }, { status: 401 });
  }
  if (url.pathname === "/v1/user") return Response.json({ data: { user: { id: userId } } });
  return Response.json({ error: { id: "404", name: "not_found" } }, { status: 404 });
}

async function startWorker() {
  worker = await unstable_startWorker({
    config: path.join(WORKER_DIR, "wrangler.jsonc"),
    entrypoint: path.join(WORKER_DIR, "test/fixtures/mcp-session-harness.js"),
    bindings: {
      DATA_ENCRYPTION_KEY: {
        type: "plain_text",
        value: "test-only-data-encryption-key-with-enough-entropy",
      },
    },
    dev: {
      // Persisted so a restart can evict every session to a cold start.
      persist: persistDir,
      outboundService: ynabStub,
      server: { port: 0 },
      inspector: false,
      watch: false,
      logLevel: "none",
    },
  });
  await worker.ready;
}

function dispatch(route, init) {
  return worker.fetch(`${ORIGIN}${route}`, init);
}

before(async () => {
  persistDir = await mkdtemp(path.join(tmpdir(), "ynab-mcp-session-"));
  await startWorker();
  for (const [accessToken, ynabUserId] of ACCESS_TOKENS) {
    const seeded = await dispatch("/__test/token", {
      method: "POST",
      body: JSON.stringify({ ynabUserId, accessToken }),
    });
    assert.equal(seeded.status, 204);
  }
});

after(async () => {
  await worker?.dispose();
  if (persistDir) await rm(persistDir, { recursive: true, force: true });
});

function grantHeaders(props) {
  return { "x-test-grant-props": JSON.stringify(props) };
}

function sseEvents(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = {};
    for (const line of block.split("\n")) {
      const [field, ...rest] = line.split(":");
      event[field] = rest.join(":").trimStart();
    }
    return event;
  });
}

async function postMcp(props, message, { sessionId, path: route = "/mcp" } = {}) {
  const headers = {
    ...grantHeaders(props),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return dispatch(route, { method: "POST", headers, body: JSON.stringify(message) });
}

async function rpcResult(response) {
  assert.equal(response.status, 200);
  const events = sseEvents(await response.text()).filter((event) => event.data);
  return JSON.parse(events.at(-1).data);
}

async function initializeSession(props) {
  const response = await postMcp(props, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "session-binding-test", version: "1.0.0" },
    },
  });
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.ok((await rpcResult(response)).result.serverInfo);
  const initialized = await postMcp(props, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId });
  assert.equal(initialized.status, 202);
  return sessionId;
}

let nextId = 100;
function getUserMessage() {
  return { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_user", arguments: {} } };
}

function resultText(message) {
  return message.result.content.map((part) => part.text).join("\n");
}

async function getUserAs(props, sessionId) {
  return resultText(await rpcResult(await postMcp(props, getUserMessage(), { sessionId })));
}

async function assertSessionNotFound(response) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
}

test("streamable HTTP session resumes only for the identity that initialized it", async () => {
  const sessionId = await initializeSession(ALICE);

  // The owner reuses the session, including under a new grant with the same
  // user and write choice (what an OAuth reconnect produces).
  assert.match(await getUserAs(ALICE, sessionId), /alice-ynab-id/);
  assert.match(await getUserAs({ ...ALICE }, sessionId), /alice-ynab-id/);

  // Bob holds a valid grant and Alice's session ID: every method is refused
  // with the same 404 an unknown session gets.
  await assertSessionNotFound(await postMcp(BOB, getUserMessage(), { sessionId }));
  await assertSessionNotFound(await dispatch("/mcp", {
    headers: { ...grantHeaders(BOB), Accept: "text/event-stream", "mcp-session-id": sessionId },
  }));
  await assertSessionNotFound(await dispatch("/mcp", {
    method: "DELETE",
    headers: { ...grantHeaders(BOB), "mcp-session-id": sessionId },
  }));
  await assertSessionNotFound(await postMcp(BOB, getUserMessage(), { sessionId: "not-a-session" }));
  await assertSessionNotFound(await dispatch("/mcp", {
    method: "DELETE",
    headers: { ...grantHeaders(BOB), "mcp-session-id": "never-used" },
  }));

  // Bob's own session still works and sees Bob; Alice's session is unharmed.
  const bobSession = await initializeSession(BOB);
  assert.notEqual(bobSession, sessionId);
  assert.match(await getUserAs(BOB, bobSession), /bob-ynab-id/);
  assert.match(await getUserAs(ALICE, sessionId), /alice-ynab-id/);
});

test("a session initialized with writes is not resumed under a read-only grant", async () => {
  const sessionId = await initializeSession(ALICE);
  await assertSessionNotFound(await postMcp(ALICE_READ_ONLY, getUserMessage(), { sessionId }));

  // The client recovers the normal way: a fresh initialize under the new grant.
  const readOnlySession = await initializeSession(ALICE_READ_ONLY);
  const tools = await rpcResult(await postMcp(ALICE_READ_ONLY, {
    jsonrpc: "2.0", id: nextId++, method: "tools/list",
  }, { sessionId: readOnlySession }));
  const writeTools = await rpcResult(await postMcp(ALICE, {
    jsonrpc: "2.0", id: nextId++, method: "tools/list",
  }, { sessionId }));
  const names = (message) => new Set(message.result.tools.map((tool) => tool.name));
  assert.ok(names(writeTools).has("create_transaction"));
  assert.ok(!names(tools).has("create_transaction"));
});

test("cold sessions keep their identity after every object is evicted", async () => {
  const sessionId = await initializeSession(ALICE);

  // Restarting workerd evicts every Durable Object, so the next request
  // starts each session cold, the case where McpAgent persists the caller's
  // props. Bob's request names his own scoped object and never reaches Alice's.
  await worker.dispose();
  await startWorker();

  await assertSessionNotFound(await postMcp(BOB, getUserMessage(), { sessionId }));
  assert.match(await getUserAs(ALICE, sessionId), /alice-ynab-id/);
});

async function openLegacySse(props, { sessionId } = {}) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const response = await dispatch(`/sse${query}`, {
    headers: { ...grantHeaders(props), Accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextEvent = async () => {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
    const end = buffer.indexOf("\n\n");
    const [event] = sseEvents(buffer.slice(0, end + 2));
    buffer = buffer.slice(end + 2);
    return event;
  };
  const endpoint = await nextEvent();
  assert.equal(endpoint.event, "endpoint");
  return {
    sessionId: new URL(endpoint.data, ORIGIN).searchParams.get("sessionId"),
    nextEvent,
    close: () => reader.cancel(),
  };
}

function postSseMessage(props, sessionId, message) {
  return dispatch(`/sse/message?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { ...grantHeaders(props), "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

async function initializeLegacySse(props, stream) {
  const initialize = {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "session-binding-test", version: "1.0.0" },
    },
  };
  assert.equal((await postSseMessage(props, stream.sessionId, initialize)).status, 202);
  assert.ok(JSON.parse((await stream.nextEvent()).data).result.serverInfo);
  assert.equal((await postSseMessage(props, stream.sessionId, {
    jsonrpc: "2.0", method: "notifications/initialized",
  })).status, 202);
}

async function legacySseGetUser(props, stream) {
  const call = getUserMessage();
  assert.equal((await postSseMessage(props, stream.sessionId, call)).status, 202);
  const reply = JSON.parse((await stream.nextEvent()).data);
  assert.equal(reply.id, call.id);
  return resultText(reply);
}

test("legacy SSE session IDs only ever reach the caller's own sessions", async () => {
  const alice = await openLegacySse(ALICE);
  // Bob attaches with Alice's session ID. McpAgent's legacy SSE handler has
  // no unknown-session check, so he is served, but by his own scoped object.
  const bob = await openLegacySse(BOB, { sessionId: alice.sessionId });
  try {
    assert.equal(bob.sessionId, alice.sessionId);
    await initializeLegacySse(ALICE, alice);
    await initializeLegacySse(BOB, bob);

    // Each identity's calls land in its own session and run as that identity;
    // the next event on each stream answers that stream's own call.
    assert.match(await legacySseGetUser(BOB, bob), /bob-ynab-id/);
    assert.match(await legacySseGetUser(ALICE, alice), /alice-ynab-id/);
    assert.match(await legacySseGetUser(BOB, bob), /bob-ynab-id/);
  } finally {
    await bob.close();
    await alice.close();
  }
});
