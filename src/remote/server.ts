import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { errors as providerErrors } from "oidc-provider";
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  validateHostHeader,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { AccessDenied, cfAccessVerifier, type CfAccessOptions } from "./cfAccess.ts";
import { mcpResource, type ServerConfig } from "./config.ts";
import {
  BodyTooLarge,
  escapeHtml,
  htmlPage,
  RateLimit,
  readBody,
  sendHtml,
  sendJson,
} from "./http.ts";
import { ensurePrivateDir, serialized } from "./files.ts";
import { createOAuth } from "./oauth.ts";
import { McpServer } from "@modelcontextprotocol/server";
// @ts-expect-error TS7016: upstream tools are plain JavaScript with no types.
import { registerAllTools } from "../tools/index.js";
import { readAnyListCredentials, sharedClient, type Guard, type GetClient } from "./anylist.ts";

/** Most clients the OAuth store will hold. Real use is one or two. */
export const MAX_CLIENTS = 50;
/** Registrations that may succeed in any hour. */
export const REGISTRATIONS_PER_HOUR = 10;
/**
 * Sign-ins that may start in any hour, over `/auth` and `/request` together. Each start that the
 * provider accepts is one entry written to `data/oauth/`, with no sign-in needed to make it.
 */
export const SIGN_IN_STARTS_PER_HOUR = 30;
/** Largest `POST /reg` body. Real client metadata is a few hundred bytes. */
const REG_BODY_MAX = 8 * 1024;
/** Largest sign-in form body. The form has one field. */
const FORM_BODY_MAX = 1024;

export interface StartOptions {
  config: ServerConfig;
  /** Test seam for the Cloudflare Access signing keys. */
  cfKeys?: CfAccessOptions["keys"];
  log?: (line: string) => void;
  /**
   * Test seam for the AnyList client. Defaults to one shared client logged in with the credentials
   * from 1Password. Pass `guard` too to keep the one-at-a-time lock and the log-in-again rule.
   */
  getClient?: GetClient;
  guard?: Guard;
  /** Test seam for the registration and sign-in limits. */
  limits?: { maxClients?: number; registrationsPerHour?: number; signInStartsPerHour?: number };
}

async function sendWeb(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The route shape for the log, so a ticket, sign-in id, or file name never lands in a log line. */
function routePattern(path: string): string {
  for (const prefix of ["/interaction/", "/auth/"]) {
    if (path.startsWith(prefix)) return `${prefix}*`;
  }
  return path;
}

const INTERACTION_PATH = /^\/interaction\/[\w-]+$/;

/** Routes one HTTP server: OAuth (oidc-provider), `/interaction/*`, and `/mcp`. */
export async function createApp(options: StartOptions): Promise<Server> {
  const { config } = options;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const resource = mcpResource(config);
  const issuer = config.publicUrl.origin;
  await ensurePrivateDir(config.dataDir);

  const maxClients = options.limits?.maxClients ?? MAX_CLIENTS;
  const oauth = await createOAuth({
    issuer,
    resource,
    dir: join(config.dataDir, "oauth"),
    maxClients,
  });
  const oidcCallback = oauth.provider.callback();
  const checkAccess = cfAccessVerifier({
    teamDomain: config.cfTeamDomain,
    aud: config.cfAccessAud,
    allowedEmail: config.allowedEmail,
    ...(options.cfKeys ? { keys: options.cfKeys } : {}),
  });
  const registrations = new RateLimit(
    options.limits?.registrationsPerHour ?? REGISTRATIONS_PER_HOUR,
    60 * 60 * 1000,
  );
  const signInStarts = new RateLimit(
    options.limits?.signInStartsPerHour ?? SIGN_IN_STARTS_PER_HOUR,
    60 * 60 * 1000,
  );

  let getClient = options.getClient;
  let guard: Guard | undefined = options.guard;
  if (!getClient) {
    const shared = sharedClient(await readAnyListCredentials(), process.env.ANYLIST_LIST_NAME);
    getClient = shared.getClient;
    guard = shared.guard;
  }
  const tools = getClient;
  const lock = guard ?? (<T>(job: () => Promise<T>) => job());

  /** One server per request. Every tool handler holds the shared lock for its whole run. */
  const buildMcpServer = (): McpServer => {
    const server = new McpServer({ name: "anylist", version: "1.0.0" });
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    Object.assign(server, {
      registerTool: (name: unknown, config: unknown, handler: (...a: unknown[]) => unknown) =>
        register(name, config, (...a: unknown[]) => lock(async () => handler(...a))),
    });
    (registerAllTools as (s: McpServer, g: GetClient) => void)(server, tools);
    return server;
  };

  const mcp = toNodeHandler(
    createMcpHandler(buildMcpServer),
    {
      onerror: (error) => {
        log(`mcp error: ${error.message}`);
      },
    },
  );
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "anylist",
  };
  const allowedHosts = [config.publicUrl.hostname, "localhost", "127.0.0.1"];

  /** Checks the Cloudflare Access assertion. Sends 403 and returns false when it fails closed. */
  async function requireAccess(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      await checkAccess(req.headers["cf-access-jwt-assertion"] as string | undefined);
      return true;
    } catch (error) {
      if (error instanceof AccessDenied) {
        sendJson(res, 403, { error: "sign-in refused" });
        return false;
      }
      throw error;
    }
  }

  const notePage = (res: ServerResponse, status: number, title: string, message: string) => {
    sendHtml(
      res,
      status,
      htmlPage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`),
    );
  };

  /** The sign-in link is not live: no cookie for it, a used link, or more than 10 minutes old. */
  const expiredPage = (res: ServerResponse) => {
    notePage(
      res,
      400,
      "This sign-in link has expired",
      "Start the connection again from claude.ai, in the same browser.",
    );
  };

  async function interaction(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!(await requireAccess(req, res))) return;
    if (!INTERACTION_PATH.test(path)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "GET") {
      let summary;
      try {
        summary = await oauth.describeInteraction(req, res);
      } catch {
        expiredPage(res);
        return;
      }
      const name = summary.clientName ? escapeHtml(summary.clientName) : "An app with no name";
      sendHtml(
        res,
        200,
        htmlPage(
          "Connect to AnyList?",
          `<h1>Connect to AnyList?</h1>
<p><strong>${name}</strong> asks for full access to your AnyList lists, recipes and meal plan. After you approve, your browser goes to <code>${escapeHtml(summary.redirectHost)}</code>.</p>
<p class="muted">Approve only if you just added this connector yourself.</p>
<form method="post"><button class="go" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
        ),
      );
      return;
    }
    if (req.method === "POST") {
      let decision: string | null;
      try {
        decision = new URLSearchParams(await readBody(req, FORM_BODY_MAX)).get("decision");
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          sendJson(res, 413, { error: "body too large" });
          return;
        }
        throw error;
      }
      if (decision !== "approve" && decision !== "deny") {
        sendJson(res, 400, { error: "choose approve or deny" });
        return;
      }
      try {
        await oauth.finishInteraction(req, res, decision);
      } catch (error) {
        // The provider refuses a post with no cookie for this link, which is what a cross-site
        // form post or a stale tab sends. Anything else is a real failure.
        if (!(error instanceof providerErrors.OIDCProviderError) || res.headersSent) throw error;
        expiredPage(res);
      }
      return;
    }
    sendJson(res, 405, { error: "use GET or POST" });
  }

  /** `POST /reg`: open by design (claude.ai registers itself), so it is capped and rate limited. */
  async function register(req: IncomingMessage, res: ServerResponse) {
    // Take a place in one step, before any await, so a burst cannot all pass the check.
    const place = registrations.tryAcquire();
    if (place.wait > 0) {
      sendJson(
        res,
        429,
        { error: "too_many_requests", error_description: "Too many registrations. Try later." },
        { "retry-after": String(place.wait) },
      );
      return;
    }
    let created = false;
    try {
      created = await registerWithPlace(req, res);
    } finally {
      // Only a registration that was created uses up a place.
      if (!created) place.release();
    }
  }

  /** Returns true when a client was created. */
  async function registerWithPlace(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let body: unknown;
    try {
      const raw = await readBody(req, REG_BODY_MAX);
      body = req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(raw) : null;
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, {
          error: "invalid_client_metadata",
          error_description: "Body too large.",
        });
        return false;
      }
      body = null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, {
        error: "invalid_client_metadata",
        error_description: "Send a JSON object.",
      });
      return false;
    }
    // One at a time, so the count check and the save cannot interleave and overshoot the cap. The
    // store enforces the cap again on every save, for any route that reaches it.
    return serialized("registration", async () => {
      if ((await oauth.clientCount()) >= maxClients) {
        // Clients never expire, so make room from the ones that never finished signing in.
        await oauth.pruneStaleClients();
      }
      if ((await oauth.clientCount()) >= maxClients) {
        sendJson(res, 400, {
          error: "invalid_client_metadata",
          error_description: "Too many registered clients.",
        });
        return false;
      }
      // The body is already read. oidc-provider takes a parsed body from req.body.
      Object.assign(req, { body });
      await oidcCallback(req, res);
      return res.statusCode === 201;
    });
  }

  /**
   * `/auth` and `POST /request`: open by design, since claude.ai's browser redirect starts here
   * with no credential. Capped, because each accepted start is one stored entry. A start the
   * provider refuses stores nothing and gives its place back.
   */
  async function startSignIn(req: IncomingMessage, res: ServerResponse) {
    const place = signInStarts.tryAcquire();
    if (place.wait > 0) {
      sendJson(
        res,
        429,
        { error: "too_many_requests", error_description: "Too many sign-ins. Try later." },
        { "retry-after": String(place.wait) },
      );
      return;
    }
    let stored = false;
    try {
      await oidcCallback(req, res);
      const location = String(res.getHeader("location") ?? "");
      stored =
        res.statusCode === 201 ||
        (res.statusCode >= 300 && res.statusCode < 400 && location.includes("/interaction/"));
    } finally {
      if (!stored) place.release();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The provider trusts the proxy, so it builds its absolute URLs (discovery, the registration
    // URI, the resume redirect) from X-Forwarded-Host when present. Hold it to the same list.
    const forwarded = req.headers["x-forwarded-host"];
    for (const name of [req.headers.host, ...(forwarded === undefined ? [] : [forwarded].flat())]) {
      if (!validateHostHeader(name, allowedHosts).ok) {
        sendJson(res, 403, { error: "invalid host" });
        return;
      }
    }
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      sendJson(res, 200, protectedResource, { "access-control-allow-origin": "*" });
      return;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      req.url = "/.well-known/openid-configuration";
      return oidcCallback(req, res);
    }
    if (path === "/mcp") {
      let auth;
      try {
        auth = await verifyBearerToken(req.headers.authorization, {
          verifier: oauth,
          resourceMetadataUrl,
          expectedResource: new URL(resource),
        });
      } catch (error) {
        return sendWeb(res, bearerAuthChallengeResponse(error, { resourceMetadataUrl }));
      }
      // exactOptionalPropertyTypes rejects IncomingMessage (method is string | undefined) here.
      return mcp(Object.assign(req, { auth }) as unknown as Parameters<typeof mcp>[0], res);
    }
    if (path.startsWith("/interaction/")) return interaction(req, res, path);
    // oidc-provider matches paths without case and without a trailing slash, so this must too.
    const bare = path.toLowerCase().replace(/\/+$/, "");
    if (bare === "/reg" && req.method === "POST") return register(req, res);
    if (bare === "/auth" || bare === "/request") return startSignIn(req, res);
    return oidcCallback(req, res);
  }

  return createServer((req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const shown = routePattern(path);
    res.on("finish", () => {
      log(`${req.method ?? "?"} ${shown} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((error: unknown) => {
      log(`error on ${shown}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      else res.end();
    });
  });
}
