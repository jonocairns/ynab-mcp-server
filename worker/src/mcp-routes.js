// MCP transport routes served behind OAuthProvider. Both only resume a
// session for the identity that initialized it (see mcp-session.js). Kept
// apart from index.js so the session tests can mount these exact handlers
// without OAuthProvider.

import { serveOwnedSessions } from "./mcp-session.js";
import { YnabMCP } from "./ynab-mcp.js";

export const MCP_API_HANDLERS = {
  "/mcp": serveOwnedSessions(YnabMCP, "/mcp"),
  "/sse": serveOwnedSessions(YnabMCP, "/sse", { transport: "sse" }),
};
