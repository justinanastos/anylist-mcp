import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { createApp, type StartOptions } from "../../src/remote/server.ts";
import type { GetClient } from "../../src/remote/anylist.ts";

/** A fake AnyList client that connects to a list called "Groceries" and touches nothing. */
export const fakeGetClient: GetClient = async () =>
  ({ connect: async () => true, targetList: { name: "Groceries" } }) as never;

export const TEAM = "team.cloudflareaccess.com";
export const AUD = "test-aud";
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export interface TestApp {
  base: string;
  dataDir: string;
  server: Server;
  /** Signs a Cloudflare Access assertion with the key the app trusts, or with `key`. */
  sign(claims: Record<string, unknown>, key?: CryptoKey): Promise<string>;
  /** A header that passes the Access check. */
  goodHeader(): Promise<Record<string, string>>;
  /** A private key the app does not trust. */
  otherKey: CryptoKey;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await once(probe.listen(0, "127.0.0.1"), "listening");
  const { port } = probe.address() as AddressInfo;
  await once(probe.close(), "close");
  return port;
}

/** Starts the real app on a free port with a temp data folder. Nothing touches the network. */
export async function startApp(
  extra: Partial<StartOptions> = {},
  /** Runs on the empty data folder before the app starts, to plant files. */
  seed?: (dataDir: string) => Promise<void>,
): Promise<TestApp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const sign: TestApp["sign"] = (claims, key = privateKey) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  const dataDir = await mkdtemp(join(tmpdir(), "anylist-mcp-"));
  await seed?.(dataDir);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = await createApp({
    config: {
      publicUrl: new URL(base),
      port,
      dataDir,
      cfTeamDomain: TEAM,
      cfAccessAud: AUD,
      allowedEmail: "justin.anastos@gmail.com",
    },
    cfKeys: createLocalJWKSet({ keys: [jwk] }),
    log: () => {},
    getClient: fakeGetClient,
    ...extra,
  });
  await once(server.listen(port, "127.0.0.1"), "listening");
  return {
    base,
    dataDir,
    server,
    sign,
    otherKey,
    async goodHeader() {
      return { "cf-access-jwt-assertion": await sign({ email: "justin.anastos@gmail.com" }) };
    },
    async close() {
      server.closeAllConnections();
      await once(server.close(), "close");
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * `POST /reg` the way claude.ai does. Its real registration (seen in `data/oauth/Client.json`) asks
 * for `client_secret_post`, so it is a confidential client with a secret, not a public one.
 */
export function register(
  base: string,
  redirectUris: string[] = [REDIRECT],
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(new URL("/reg", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Claude",
      ...extra,
    }),
  });
}
