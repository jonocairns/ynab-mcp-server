// Binds every MCP session to the identity that created it.
//
// McpAgent (agents 0.17.x) addresses one Durable Object per session by the
// Mcp-Session-Id header for streamable HTTP and the sessionId query parameter
// for legacy SSE. Following the MCP guidance to key session state as
// <user>:<session>, each request gets a Durable Object namespace scoped to
// the caller: every session name it resolves carries the caller's owner key.
// The same ID presented under a different user or write choice names a
// different, uninitialized object, and McpAgent answers it as an unknown
// session.

// The owner fields the agent bakes into the MCP server at init. A session
// may only be resumed under a grant carrying exactly these values.
export function sessionOwner(props) {
  const ynabUserId = props?.ynabUserId;
  if (typeof ynabUserId !== "string" || !ynabUserId) return null;
  return { ynabUserId, writesEnabled: !!props.writesEnabled };
}

// Hashed so Durable Object names never carry the YNAB user ID itself.
export async function sessionOwnerKey(owner) {
  const material = new TextEncoder().encode(`${owner.ynabUserId}\n${owner.writesEnabled ? "rw" : "r"}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// McpAgent and partyserver reach a session only through idFromName(name),
// then get(id).setName(name, props); partyserver requires both to use the
// same name. Only those methods are exposed, so a library change that
// addresses sessions any other way fails loudly instead of going unscoped.
export function ownerScopedNamespace(namespace, ownerKey) {
  const scoped = (name) => `${name}@${ownerKey}`;
  return {
    newUniqueId: (options) => namespace.newUniqueId(options),
    idFromName: (name) => namespace.idFromName(scoped(name)),
    get(id, options) {
      const stub = namespace.get(id, options);
      return new Proxy(stub, {
        get(target, property) {
          if (property === "setName") return (name, props) => target.setName(scoped(name), props);
          // RPC stub methods need the stub as `this`, and the stub answers
          // any property (even "bind") as a remote method, so call through.
          const value = Reflect.get(target, property);
          return typeof value === "function" ? (...args) => target[property](...args) : value;
        },
      });
    },
  };
}

// McpAgent.serve(), except the handler only ever sees the caller's scoped
// namespace. Both read the binding from the same options.
export function serveOwnedSessions(agent, path, options = {}) {
  const handler = agent.serve(path, options);
  const binding = options.binding ?? "MCP_OBJECT";
  return {
    async fetch(request, env, ctx) {
      const owner = sessionOwner(ctx.props);
      if (!owner) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
      const namespace = ownerScopedNamespace(env[binding], await sessionOwnerKey(owner));
      return handler.fetch(request, { ...env, [binding]: namespace }, ctx);
    },
  };
}
