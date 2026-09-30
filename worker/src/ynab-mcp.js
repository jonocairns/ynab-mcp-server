// Durable Object-backed MCP agent: one instance per authenticated session.
// The entire tool/prompt/resource surface comes from the shared factory in
// the repo root (same code the local stdio server runs); this file only
// supplies the per-user token getter, write flag, and KV undo journal.

import { McpAgent } from "agents/mcp";
import { createYnabServer } from "../../index.js";
import { REMOTE_SERVER_INFO } from "./brand-assets.js";
import { getFreshAccessToken, createKvJournal } from "./ynab-oauth.js";

export class YnabMCP extends McpAgent {
  async init() {
    // McpAgent's DELETE handler starts a session object without props. That
    // object was never initialized, so McpAgent answers 404 before any tool
    // runs; it gets a server without YNAB credentials instead of crashing.
    const { ynabUserId, writesEnabled } = this.props ?? {};
    const credentials = ynabUserId ? {
      // Called per outbound YNAB request; handles the 2-hour token expiry by
      // refreshing (and rotating the refresh token) inside the safety window.
      getAccessToken: () => getFreshAccessToken(this.env, ynabUserId),
      hasCredentials: true,
      writesEnabled: !!writesEnabled,
      journal: createKvJournal(this.env, ynabUserId),
    } : {};
    const { server } = createYnabServer({
      ...credentials,
      runtime: {
        tokenSource: { source: "ynab_oauth", source_label: "YNAB OAuth (hosted connector)" },
        detected_agent: "remote",
        config_fallback_disabled: true,
        sources_checked: [],
        values: {},
      },
      serverInfo: REMOTE_SERVER_INFO,
    });
    this.server = server;
  }
}
