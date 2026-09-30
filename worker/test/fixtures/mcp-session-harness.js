// Test-only Worker entry: the production MCP routes and agent, with
// OAuthProvider replaced by a header that names the grant props. It lets the
// session tests act as different authenticated users without live OAuth.

import { MCP_API_HANDLERS } from "../../src/mcp-routes.js";
import { saveTokenRecord } from "../../src/ynab-oauth.js";

export { YnabMCP } from "../../src/ynab-mcp.js";
export { OAuthTransientState } from "../../src/oauth-transient-state.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/__test/token" && request.method === "POST") {
      // Stores a YNAB token record the way the OAuth callback does.
      const { ynabUserId, accessToken } = await request.json();
      const record = { accessToken, refreshToken: null, expiresAt: Date.now() + 60 * 60 * 1000 };
      await saveTokenRecord(env.OAUTH_KV, ynabUserId, record, env.DATA_ENCRYPTION_KEY);
      return new Response(null, { status: 204 });
    }
    const route = Object.keys(MCP_API_HANDLERS).find((path) => pathname.startsWith(path));
    if (!route) return new Response("Not found", { status: 404 });
    // OAuthProvider assigns the decrypted grant props the same way.
    ctx.props = JSON.parse(request.headers.get("x-test-grant-props") ?? "null");
    return MCP_API_HANDLERS[route].fetch(request, env, ctx);
  },
};
