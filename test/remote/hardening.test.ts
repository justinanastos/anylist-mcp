import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAdapter } from "../../src/remote/fileAdapter.ts";
import { REDIRECT, register, startApp } from "./helpers.ts";

test("registration is capped at 50 clients, and an existing client survives the flood", async () => {
  const app = await startApp({ limits: { registrationsPerHour: 1000 } });
  try {
    const first = await register(app.base);
    assert.equal(first.status, 201);
    const { client_id } = (await first.json()) as { client_id: string };

    for (let i = 1; i < 50; i++) assert.equal((await register(app.base)).status, 201);
    const refused = await register(app.base);
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: string }).error, "invalid_client_metadata");

    // The first client is still known: /auth reaches the sign-in page for it.
    const query = new URLSearchParams({
      client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      scope: "mcp",
      resource: `${app.base}/mcp`,
    });
    const auth = await fetch(new URL(`/auth?${query.toString()}`, app.base), {
      redirect: "manual",
    });
    assert.match(auth.headers.get("location") ?? "", /\/interaction\//);

    // A body over the size cap is refused before anything is stored.
    const big = await register(app.base, [REDIRECT], { client_name: "x".repeat(20_000) });
    assert.equal(big.status, 413);
  } finally {
    await app.close();
  }
});

test("registration is limited to 10 per hour", async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await register(app.base)).status, 201);
    const limited = await register(app.base);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    await app.close();
  }
});

test("concurrent saves of one OAuth model keep every entry and the latest value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anylist-mcp-adapter-"));
  try {
    const model = fileAdapter(dir)("RefreshToken");
    const ids = Array.from({ length: 150 }, (_, i) => `token-${i}`);
    await Promise.all(ids.map((id, i) => model.upsert(id, { jti: id, n: i }, 3600)));
    // A later change to the same entries, also concurrent: consume must survive a reload.
    await Promise.all(ids.slice(0, 40).map((id) => model.consume(id)));

    const reloaded = fileAdapter(dir)("RefreshToken");
    for (const [i, id] of ids.entries()) {
      const found = await reloaded.find(id);
      assert.ok(found, `${id} is missing after reload`);
      assert.equal(found.n, i);
      assert.equal(typeof found.consumed === "number", i < 40, `${id} consumed flag`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** `POST <path>` the way claude.ai registers, but to any spelling of the path. */
function registerAt(base: string, path: string, extra: Record<string, unknown> = {}) {
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      ...extra,
    }),
  });
}

test("POST /REG and POST /reg/ are capped like /reg", async () => {
  const app = await startApp({ limits: { maxClients: 3, registrationsPerHour: 1000 } });
  try {
    assert.equal((await registerAt(app.base, "/REG")).status, 201);
    assert.equal((await registerAt(app.base, "/reg/")).status, 201);
    assert.equal((await registerAt(app.base, "/Reg/")).status, 201);
    for (const path of ["/reg", "/REG", "/reg/"]) {
      const refused = await registerAt(app.base, path);
      assert.equal(refused.status, 400, `${path} is capped`);
    }
    const stored = JSON.parse(
      await readFile(join(app.dataDir, "oauth", "Client.json"), "utf8"),
    ) as object;
    assert.equal(Object.keys(stored).length, 3);
  } finally {
    await app.close();
  }
});

test("POST /REG and POST /reg/ share the rate limit and the body limit", async () => {
  const app = await startApp({ limits: { registrationsPerHour: 2 } });
  try {
    assert.equal((await registerAt(app.base, "/REG")).status, 201);
    assert.equal((await registerAt(app.base, "/reg/")).status, 201);
    for (const path of ["/reg", "/REG", "/reg/"]) {
      assert.equal((await registerAt(app.base, path)).status, 429, `${path} is rate limited`);
    }
  } finally {
    await app.close();
  }
  const roomy = await startApp({ limits: { registrationsPerHour: 1000 } });
  try {
    for (const path of ["/REG", "/reg/"]) {
      const big = await registerAt(roomy.base, path, { client_name: "x".repeat(20_000) });
      assert.equal(big.status, 413, `${path} has a body limit`);
    }
  } finally {
    await roomy.close();
  }
});

test("a burst of registrations cannot pass the hourly limit", async () => {
  const app = await startApp({ limits: { registrationsPerHour: 5 } });
  try {
    const answers = await Promise.all(Array.from({ length: 20 }, () => register(app.base)));
    const created = answers.filter((answer) => answer.status === 201).length;
    assert.equal(created, 5);
    assert.equal(answers.filter((answer) => answer.status === 429).length, 15);
  } finally {
    await app.close();
  }
});

test("the adapter itself refuses a new client past the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anylist-mcp-adapter-"));
  try {
    const clients = fileAdapter(dir, { maxClients: 2 })("Client");
    await clients.upsert("a", { client_id: "a" });
    await clients.upsert("b", { client_id: "b" });
    await assert.rejects(clients.upsert("c", { client_id: "c" }), /too many/i);
    // Changing a client that exists is not a new client.
    await clients.upsert("a", { client_id: "a", client_name: "renamed" });
    assert.equal(await clients.find("c"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const DAY_S = 24 * 60 * 60;

function clientPayload(id: string, issuedAt: number) {
  return {
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    id_token_signed_response_alg: "RS256",
    require_auth_time: false,
    response_types: ["code"],
    subject_type: "public",
    token_endpoint_auth_method: "none",
    post_logout_redirect_uris: [],
    require_pushed_authorization_requests: false,
    dpop_bound_access_tokens: false,
    client_id_issued_at: issuedAt,
    client_id: id,
    redirect_uris: [REDIRECT],
  };
}

test("at the cap, old clients with no grant are dropped, and a client with a grant is kept", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const staleAt = nowS - 3 * DAY_S;
  const staleIds = Array.from({ length: 50 }, (_, i) => `stale-${i}`);
  const app = await startApp(
    { limits: { maxClients: 50, registrationsPerHour: 1000 } },
    async (dataDir) => {
      const dir = join(dataDir, "oauth");
      await mkdir(dir, { recursive: true });
      const clients = Object.fromEntries(
        [...staleIds, "granted"].map((id) => [id, { payload: clientPayload(id, staleAt) }]),
      );
      const tokens = Object.fromEntries(
        [...staleIds, "granted"].map((id) => [
          `rat-${id}`,
          {
            payload: {
              iat: staleAt,
              clientId: id,
              kind: "RegistrationAccessToken",
              jti: `rat-${id}`,
            },
          },
        ]),
      );
      const grants = {
        "grant-1": {
          payload: { accountId: "justin", clientId: "granted", kind: "Grant", jti: "grant-1" },
        },
      };
      await writeFile(join(dir, "Client.json"), JSON.stringify(clients));
      await writeFile(join(dir, "RegistrationAccessToken.json"), JSON.stringify(tokens));
      await writeFile(join(dir, "Grant.json"), JSON.stringify(grants));
    },
  );
  try {
    const created = await register(app.base);
    assert.equal(created.status, 201);

    const oauthDir = join(app.dataDir, "oauth");
    const clients = JSON.parse(await readFile(join(oauthDir, "Client.json"), "utf8")) as object;
    assert.equal(Object.keys(clients).length, 2, "the granted client and the new one");
    assert.ok("granted" in clients);
    const tokens = JSON.parse(
      await readFile(join(oauthDir, "RegistrationAccessToken.json"), "utf8"),
    ) as Record<string, { payload: { clientId: string } }>;
    assert.ok(
      Object.values(tokens).every((token) => !token.payload.clientId.startsWith("stale-")),
      "the stale clients' registration tokens are gone",
    );
    assert.ok("rat-granted" in tokens);

    // The granted client still reaches the sign-in page.
    const query = new URLSearchParams({
      client_id: "granted",
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      scope: "mcp",
      resource: `${app.base}/mcp`,
    });
    const auth = await fetch(new URL(`/auth?${query.toString()}`, app.base), {
      redirect: "manual",
    });
    assert.match(auth.headers.get("location") ?? "", /\/interaction\//);
  } finally {
    await app.close();
  }
});

test("at the cap, recent clients and clients with a grant are never dropped", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const app = await startApp(
    { limits: { maxClients: 3, registrationsPerHour: 1000 } },
    async (dataDir) => {
      const dir = join(dataDir, "oauth");
      await mkdir(dir, { recursive: true });
      const clients = {
        fresh: { payload: clientPayload("fresh", nowS - 3600) },
        old1: { payload: clientPayload("old1", nowS - 3 * DAY_S) },
        old2: { payload: clientPayload("old2", nowS - 3 * DAY_S) },
      };
      const grants = Object.fromEntries(
        ["old1", "old2"].map((id) => [
          `g-${id}`,
          { payload: { accountId: "justin", clientId: id, kind: "Grant", jti: `g-${id}` } },
        ]),
      );
      await writeFile(join(dir, "Client.json"), JSON.stringify(clients));
      await writeFile(join(dir, "Grant.json"), JSON.stringify(grants));
    },
  );
  try {
    assert.equal((await register(app.base)).status, 400);
    const stored = JSON.parse(
      await readFile(join(app.dataDir, "oauth", "Client.json"), "utf8"),
    ) as object;
    assert.deepEqual(Object.keys(stored).sort(), ["fresh", "old1", "old2"]);
  } finally {
    await app.close();
  }
});

/** The `/auth` query claude.ai's browser redirect carries. */
function authQuery(client_id: string): string {
  return new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    scope: "mcp",
  }).toString();
}

test("anonymous sign-in starts are capped: /auth and /request share one limit, and only a stored start counts", async () => {
  const app = await startApp({ limits: { signInStartsPerHour: 3 } });
  try {
    const reg = await register(app.base);
    assert.equal(reg.status, 201);
    const { client_id, client_secret } = (await reg.json()) as {
      client_id: string;
      client_secret: string;
    };
    const start = (path: string) =>
      fetch(new URL(`${path}?${authQuery(client_id)}`, app.base), { redirect: "manual" });

    // A request for an unknown client stores nothing, so it does not use up a place.
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(new URL(`/auth?${authQuery("nobody")}`, app.base));
      assert.equal(bad.status, 400);
    }

    assert.equal((await start("/auth")).status, 303);
    assert.equal((await start("/AUTH")).status, 303);
    const par = await fetch(new URL("/request", app.base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${authQuery(client_id)}&client_secret=${client_secret}`,
    });
    assert.equal(par.status, 201, await par.text());

    for (const path of ["/auth", "/auth/", "/Auth"]) {
      const limited = await start(path);
      assert.equal(limited.status, 429, `${path} is capped`);
      assert.ok(limited.headers.get("retry-after"));
    }
    const parLimited = await fetch(new URL("/request", app.base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${authQuery(client_id)}&client_secret=${client_secret}`,
    });
    assert.equal(parLimited.status, 429);

    // Every anonymous start became one stored entry, and the cap bounds the store.
    const oauthDir = join(app.dataDir, "oauth");
    const interactions = JSON.parse(
      await readFile(join(oauthDir, "Interaction.json"), "utf8"),
    ) as object;
    assert.equal(Object.keys(interactions).length, 2);
    const pushed = JSON.parse(
      await readFile(join(oauthDir, "PushedAuthorizationRequest.json"), "utf8"),
    ) as object;
    assert.equal(Object.keys(pushed).length, 1);
  } finally {
    await app.close();
  }
});

test("only the OAuth routes claude.ai needs exist, and a client cannot make the server fetch its keys", async () => {
  const app = await startApp();
  try {
    const status = async (path: string, init: RequestInit = {}) =>
      (await fetch(new URL(path, app.base), { redirect: "manual", ...init })).status;
    assert.equal(await status("/session/end"), 404, "RP-initiated logout");
    // The provider keeps its confirm route for its own account-switch logout, which cannot happen
    // with one fixed account. With no logout state it refuses.
    assert.equal(await status("/session/end/confirm", { method: "POST" }), 400);
    assert.equal(await status("/me"), 404, "userinfo");
    assert.equal(await status("/token/introspection", { method: "POST" }), 404);
    assert.equal(await status("/device/auth", { method: "POST" }), 404);
    assert.equal(await status("/backchannel", { method: "POST" }), 404);

    const discovery = (await (
      await fetch(new URL("/.well-known/oauth-authorization-server", app.base))
    ).json()) as Record<string, unknown>;
    assert.equal(discovery.end_session_endpoint, undefined);
    assert.equal(discovery.userinfo_endpoint, undefined);
    assert.deepEqual((discovery.token_endpoint_auth_methods_supported as string[]).sort(), [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ]);

    // A key-based client auth method would make the server fetch jwks_uri on a /token call.
    for (const method of ["private_key_jwt", "client_secret_jwt"]) {
      const res = await register(app.base, [REDIRECT], {
        token_endpoint_auth_method: method,
        jwks_uri: "https://attacker.example/jwks",
      });
      assert.equal(res.status, 400, method);
    }
    assert.equal(
      (await register(app.base, [REDIRECT], { jwks_uri: "https://a.example/jwks" })).status,
      400,
      "jwks_uri",
    );
    assert.equal(
      (await register(app.base, [REDIRECT], { jwks: { keys: [] } })).status,
      400,
      "jwks",
    );
    assert.equal((await register(app.base)).status, 201, "claude.ai's own shape");
    assert.equal(
      (await register(app.base, [REDIRECT], { token_endpoint_auth_method: "none" })).status,
      201,
    );
  } finally {
    await app.close();
  }
});

test("a forwarded host the tunnel would never send is refused, so the provider never builds a URL from it", async () => {
  const app = await startApp();
  try {
    const forged = { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
    const discovery = await fetch(new URL("/.well-known/oauth-authorization-server", app.base), {
      headers: forged,
    });
    assert.equal(discovery.status, 403);
    const reg = await fetch(new URL("/reg", app.base), {
      method: "POST",
      headers: { "content-type": "application/json", ...forged },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    assert.equal(reg.status, 403);
    assert.doesNotMatch(await reg.text(), /evil\.example/);

    // The host the tunnel does send, in the forwarded header, still works.
    const ok = await fetch(new URL("/.well-known/oauth-authorization-server", app.base), {
      headers: { "x-forwarded-host": new URL(app.base).host, "x-forwarded-proto": "https" },
    });
    assert.equal(ok.status, 200);
    assert.match(
      ((await ok.json()) as { token_endpoint: string }).token_endpoint,
      new RegExp(`^https://${new URL(app.base).host}/token$`),
    );
  } finally {
    await app.close();
  }
});

test("an Access assertion that starts a few seconds from now is accepted, so a fresh sign-in is not refused by clock drift", async () => {
  const app = await startApp();
  try {
    const soon = Math.floor(Date.now() / 1000) + 10;
    const header = {
      "cf-access-jwt-assertion": await app.sign({ email: "justin.anastos@gmail.com", nbf: soon }),
    };
    // A good header passes requireAccess. The unknown sign-in uid then reaches expiredPage.
    assert.equal((await fetch(new URL("/interaction/abc", app.base), { headers: header })).status, 400);
    const late = Math.floor(Date.now() / 1000) + 120;
    const tooSoon = {
      "cf-access-jwt-assertion": await app.sign({ email: "justin.anastos@gmail.com", nbf: late }),
    };
    assert.equal((await fetch(new URL("/interaction/abc", app.base), { headers: tooSoon })).status, 403);
  } finally {
    await app.close();
  }
});
