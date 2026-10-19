import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import Provider, { errors, interactionPolicy, type Configuration } from "oidc-provider";
import { OAuthError, type AuthInfo } from "@modelcontextprotocol/server";
import { writeFileAtomic } from "./files.ts";
import { fileAdapter } from "./fileAdapter.ts";

/** Redirects claude.ai uses after sign-in. Any other redirect is refused at registration. */
const ALLOWED_REDIRECT = /^https:\/\/(claude\.ai|claude\.com)\//;
const ACCOUNT_ID = "justin-anylist";

/**
 * Every `/auth` goes through `/interaction/<uid>`, so every sign-in needs the Access check and an
 * Approve tap. Without this, a browser that holds the provider's session cookie and a client that
 * already has a grant get a code with no page shown at all. A link that someone else made could
 * then sign their connector in silently. The check passes only on the resume that follows our own
 * `login` result, so the interaction cannot loop.
 */
function approveEveryTime(): interactionPolicy.Prompt[] {
  const { base, Check } = interactionPolicy;
  const policy = base();
  policy
    .get("login")
    ?.checks.add(
      new Check("approve_every_time", "every sign-in needs an Approve tap", (ctx) =>
        ctx.oidc.result?.login ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT,
      ),
    );
  return policy;
}

/** Signing key and cookie keys, made once and kept in `data/oauth/keys.json`. */
async function loadKeys(dir: string): Promise<{ cookieKeys: string[]; jwks: { keys: object[] } }> {
  const path = join(dir, "keys.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as {
      cookieKeys: string[];
      jwks: { keys: object[] };
    };
  } catch {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = {
      ...(await exportJWK(privateKey)),
      use: "sig",
      alg: "RS256",
      kid: randomBytes(8).toString("hex"),
    };
    const keys = { cookieKeys: [randomBytes(32).toString("base64url")], jwks: { keys: [jwk] } };
    await writeFileAtomic(path, JSON.stringify(keys));
    return keys;
  }
}

export interface InteractionSummary {
  /** The name the client registered. Untrusted text: escape it before showing it. */
  clientName: string | undefined;
  /** Host the browser returns to after sign-in. */
  redirectHost: string;
}

export interface OAuth {
  provider: Provider;
  /** How many clients are registered. */
  clientCount(): Promise<number>;
  /** Drops clients with no Grant that registered over 24 hours ago. Returns how many. */
  pruneStaleClients(): Promise<number>;
  /** Who is asking to sign in, for the Approve page. Throws when the sign-in link is not live. */
  describeInteraction(req: IncomingMessage, res: ServerResponse): Promise<InteractionSummary>;
  /**
   * Ends `/interaction/<uid>` after Cloudflare Access and our own check have passed, and the person
   * tapped a button. Approve grants everything asked. Deny ends with `access_denied`.
   */
  finishInteraction(
    req: IncomingMessage,
    res: ServerResponse,
    decision: "approve" | "deny",
  ): Promise<void>;
  /** Looks up an opaque access token. Throws `invalid_token` for anything not issued for `/mcp`. */
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export async function createOAuth(options: {
  issuer: string;
  resource: string;
  dir: string;
  /** Most registered clients. The store refuses a new one past this. */
  maxClients?: number;
}): Promise<OAuth> {
  const { issuer, resource, dir } = options;
  const keys = await loadKeys(dir);
  const adapter = fileAdapter(dir, {
    ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
  });
  const configuration: Configuration = {
    adapter,
    jwks: keys.jwks,
    cookies: { keys: keys.cookieKeys },
    findAccount: (_ctx, sub) => ({ accountId: sub, claims: () => ({ sub }) }),
    scopes: ["openid", "offline_access", "mcp"],
    pkce: { required: () => true },
    // claude.ai registers with client_secret_post. The key-based methods are out because they make
    // the server fetch the client's jwks_uri on an anonymous /token call.
    clientAuthMethods: ["client_secret_post", "client_secret_basic", "none"],
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      // Not part of the claude.ai flow. Logout would let any registered client send the browser to
      // its post_logout_redirect_uri after a confirm click, and userinfo has nothing to say.
      rpInitiatedLogout: { enabled: false },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator.replace(/\/$/, "") !== resource) throw new errors.InvalidTarget();
          return {
            scope: "mcp",
            audience: resource,
            accessTokenTTL: 60 * 60,
            accessTokenFormat: "opaque",
          };
        },
      },
    },
    extraClientMetadata: {
      properties: ["anylist_client_check"],
      validator(_ctx, key, _value, metadata) {
        if (key !== "anylist_client_check") return;
        const uris = metadata.redirect_uris ?? [];
        if (uris.length === 0 || !uris.every((uri) => ALLOWED_REDIRECT.test(uri))) {
          throw new errors.InvalidRedirectUri("only claude.ai redirects are allowed");
        }
        // No feature here reads client keys. Refusing them keeps it that way if one is turned on.
        if (metadata.jwks !== undefined || metadata.jwks_uri !== undefined) {
          throw new errors.InvalidClientMetadata("client keys are not used");
        }
      },
    },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: true,
    ttl: {
      AccessToken: 60 * 60,
      AuthorizationCode: 60,
      Interaction: 10 * 60,
      Session: 14 * 24 * 60 * 60,
      Grant: 365 * 24 * 60 * 60,
      RefreshToken: 90 * 24 * 60 * 60,
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: approveEveryTime(),
    },
  };
  const provider = new Provider(issuer, configuration);
  provider.proxy = true;

  return {
    provider,
    clientCount: () => adapter.count("Client"),
    pruneStaleClients: () => adapter.pruneStaleClients(),
    async describeInteraction(req, res) {
      const details = await provider.interactionDetails(req, res);
      const client = await provider.Client.find(String(details.params.client_id));
      const redirect = details.params.redirect_uri;
      let redirectHost = "unknown";
      try {
        redirectHost = new URL(typeof redirect === "string" ? redirect : "").host;
      } catch {
        // Show "unknown": the page must still render so the person can deny.
      }
      return { clientName: client?.clientName, redirectHost };
    },
    async finishInteraction(req, res, decision) {
      if (decision === "deny") {
        await provider.interactionFinished(
          req,
          res,
          { error: "access_denied", error_description: "The sign-in was denied." },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      const details = await provider.interactionDetails(req, res);
      const clientId = String(details.params.client_id);
      const grant = details.grantId
        ? ((await provider.Grant.find(details.grantId)) ??
          new provider.Grant({ accountId: ACCOUNT_ID, clientId }))
        : new provider.Grant({ accountId: ACCOUNT_ID, clientId });
      const missing = details.prompt.details as {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
      // Grant everything the request asks for now, so the login and consent steps finish on one tap.
      // Without this the login step would end first and the consent step would show a second page.
      const asked = typeof details.params.scope === "string" ? details.params.scope.split(" ") : [];
      const wanted = asked.filter((scope) => scope !== "");
      if (wanted.length > 0) grant.addOIDCScope(wanted.join(" "));
      if (wanted.includes("mcp")) {
        for (const indicator of [details.params.resource ?? resource].flat()) {
          if (typeof indicator === "string") grant.addResourceScope(indicator, "mcp");
        }
      }
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
      for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        grant.addResourceScope(indicator, scopes.join(" "));
      }
      const grantId = await grant.save();
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId: ACCOUNT_ID }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      );
    },
    async verifyAccessToken(token) {
      const at = await provider.AccessToken.find(token);
      if (!at?.aud || [at.aud].flat().every((aud) => aud !== resource) || !at.exp) {
        throw new OAuthError("invalid_token", "unknown or wrong-audience token");
      }
      return {
        token,
        clientId: at.clientId ?? "",
        scopes: at.scope ? at.scope.split(" ") : [],
        expiresAt: at.exp,
        resource: new URL(resource),
      };
    },
  };
}
