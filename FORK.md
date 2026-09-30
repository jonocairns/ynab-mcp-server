# ynab.tycho.nz deployment

This fork runs the hosted connector in `worker/` at **https://ynab.tycho.nz/mcp** for personal use, on the free Workers plan of my Cloudflare account. The rest of the repository is upstream [oliverames/ynab-mcp-server](https://github.com/oliverames/ynab-mcp-server), unchanged.

## What differs from upstream

- `worker/wrangler.jsonc`: `ynab.tycho.nz` custom domain and `CONNECTOR_BASE_URL`, this account's `OAUTH_KV` namespace id, and `MCP_ALLOWED_ORIGINS` limited to `https://claude.ai,https://claude.com`.
- `worker/src/brand-assets.js`: `CONNECTOR_ORIGIN` is `https://ynab.tycho.nz`. It feeds the OAuth protected-resource metadata, so a stale value sends sign-in to someone else's server.
- `worker/src/pages.js`, `worker/src/response-security.js`, `worker/package.json`, `worker/test/worker.test.mjs`: the same hostname swap.

Everything else lives in Cloudflare, not in Git:

- Worker secrets: `YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY`.
- The YNAB OAuth app's redirect URI: `https://ynab.tycho.nz/callback`.
- `tycho.nz` WAF custom rule that skips Browser Integrity Check for `/mcp`, `/sse`, `/register`, `/token`, and `/.well-known/`, plus a rate-limiting rule on `/register`.

## Update from upstream and redeploy

Never use GitHub's "Sync fork" button. Whatever reaches `main` gets deployed, and it runs with access to the budget, so read upstream changes first.

1. Fetch and review:

   ```sh
   cd /home/jonoc/ynab-mcp-server
   git switch main && git pull
   git fetch upstream
   git log --oneline main..upstream/main
   git diff main...upstream/main -- worker/ index.js package.json package-lock.json
   ```

   Look for new outbound hosts, changes to token storage or OAuth handling, new dependencies, and new secrets, bindings, or migrations in `worker/wrangler.jsonc` or `worker/README.md`.

2. Merge. Conflicts, if any, will be in the files listed above. Keep upstream's change and re-apply `ynab.tycho.nz`:

   ```sh
   git merge upstream/main
   grep -rn "amesvt" worker/src worker/test worker/wrangler.jsonc worker/package.json
   ```

   The grep must print nothing. If upstream added a new hard-coded `ynab.amesvt.com`, replace it with `ynab.tycho.nz`.

3. Install and test:

   ```sh
   npm ci --ignore-scripts
   cd worker
   npm ci --ignore-scripts
   npm test
   npx wrangler deploy --dry-run --outdir /tmp/ynab-worker-build
   ```

   Check that the dry run lists `OAUTH_KV (6655e349d1d84f4b94eb8553fe61a32d)` and `CONNECTOR_BASE_URL ("https://ynab.tycho.nz")`.

4. Deploy:

   ```sh
   npx wrangler login
   npx wrangler deploy
   npx wrangler logout
   ```

   If upstream added a new secret, set it with `npx wrangler secret put <NAME>` before deploying.

5. Verify:

   ```sh
   curl -s https://ynab.tycho.nz/.well-known/oauth-protected-resource/mcp
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ynab.tycho.nz/mcp
   ```

   The first must name only `https://ynab.tycho.nz`; the second should print `401`. Then ask Claude.ai to list YNAB budgets. If the connector stops working, reconnect it in Claude.ai.

6. Push: `git push origin main`.

## Roll back

`npx wrangler rollback` restores the previous Worker version (it needs `wrangler login`). Then revert the merge on `main` so Git matches what is live.
