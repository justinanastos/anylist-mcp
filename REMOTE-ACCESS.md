# anylist-mcp remote access

`anylist-mcp` runs as a launchd agent and answers at `https://anylist.anastos-home.net`. claude.ai on Justin's phone signs in to it as a remote MCP connector. It logs in to AnyList as Justin.

## What are the moving parts?

| Thing | Value |
| --- | --- |
| Public URL | `https://anylist.anastos-home.net`, with the MCP endpoint at `/mcp` |
| Local URL | `http://127.0.0.1:8441`. It listens on loopback only, so the LAN cannot reach it. |
| launchd agent | `com.justin.anylist-mcp`, plist at `~/Library/LaunchAgents/com.justin.anylist-mcp.plist`, mode `0600` |
| Plist template | `deploy/com.justin.anylist-mcp.plist`. It holds two placeholders, `__CF_ACCESS_AUD__` and `__OP_SERVICE_ACCOUNT_TOKEN__`. |
| Default list | `ANYLIST_LIST_NAME=Grocery List` in the plist |
| AnyList login | 1Password item `AnyList` in vault `Mac Mini`, read by `op` once at startup |
| Log | `/tmp/anylist-mcp.log`. It records method, path pattern, status and time, never query strings. |
| Private data | `data/`, gitignored. `data/oauth/` holds live tokens, client secrets and the signing key. Outside the repo, anylist-js writes `~/.anylist_credentials` (access and refresh tokens, encrypted with the AnyList password). Deleting it forces a fresh login. |
| Tunnel | The shared tunnel, rule `anylist.anastos-home.net` to `http://localhost:8441` in `~/.cloudflared/config.yml` |
| Access app | `anylist-signin`, reusable policy `me-only`, on `/interaction/*` only, 24-hour session |
| Skill | `skill/anylist-meal-planning/`. Every push to `main` touching `skill/` rebuilds the zip and replaces the `skill` release. Download: https://github.com/justinanastos/anylist-mcp/releases/download/skill/anylist-meal-planning-skill.zip |

## Who can reach what?

Only Justin can sign in, and only claude.ai holds a token afterwards. Cloudflare Access guards just the sign-in pages, because claude.ai's servers cannot pass a Google sign-in when they call `/mcp`.

| Route | Guard | Without it |
| --- | --- | --- |
| `/mcp` | Bearer token from the server's own OAuth, bound to `/mcp` | 401 |
| `/interaction/*` | Cloudflare Access, then the server checks the `Cf-Access-Jwt-Assertion` and Justin's email, then he taps Approve | 302 to Google, or 403 |
| `/reg` | Open, capped, and accepts claude.ai redirects only | 400 or 429 |

## How do I check it is healthy?

```bash
launchctl list | grep anylist-mcp                    # a PID and exit status 0
tail -20 /tmp/anylist-mcp.log
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://anylist.anastos-home.net/mcp                     # 401
curl -s -o /dev/null -w "%{http_code}\n" https://anylist.anastos-home.net/interaction/x                    # 302
curl -s -o /dev/null -w "%{http_code}\n" https://anylist.anastos-home.net/.well-known/oauth-protected-resource/mcp  # 200
```

## How do I restart, stop, or redeploy it?

```bash
launchctl kickstart -k gui/$(id -u)/com.justin.anylist-mcp     # restart, picks up code changes
launchctl bootout gui/$(id -u)/com.justin.anylist-mcp          # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.justin.anylist-mcp.plist   # start
```

## What doesn't AnyList allow?

- **Removing a recipe from a collection.** The server ignores every form of that operation, so the tool has no remove action. Do it in the AnyList app.
- **Editing a meal plan event in place.** The server ignores `set-event-details`. `update_event` creates the changed event first, then deletes the old one, so the event gets a new id.

## How do I cut off access?

| To stop | Do this |
| --- | --- |
| Everything | `launchctl bootout gui/$(id -u)/com.justin.anylist-mcp` |
| claude.ai's token | Delete `data/oauth/Grant.json`, `AccessToken.json` and `RefreshToken.json`, then restart. The connector must sign in again. |
| The public hostname | Remove the `anylist.anastos-home.net` rule from `~/.cloudflared/config.yml` and kickstart `com.justin.cloudflared` |
