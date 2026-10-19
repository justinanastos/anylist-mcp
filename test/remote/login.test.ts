import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { REDIRECT, register, startApp, type TestApp } from "./helpers.ts";

let app: TestApp;
let base: string;
const cookies = new Map<string, string>();

before(async () => {
  app = await startApp();
  base = app.base;
});

after(() => app.close());

function remember(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [pair = ""] = c.split(";");
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(new URL(path, base), {
    redirect: "manual",
    headers: { ...headers, cookie: cookieHeader() },
  });
  remember(res);
  return res;
}

async function postForm(
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(new URL(path, base), {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, cookie: cookieHeader() },
    body: new URLSearchParams(body),
  });
  remember(res);
  return res;
}

const post = (path: string, body: Record<string, string>) =>
  fetch(new URL(path, base), { method: "POST", body: new URLSearchParams(body) });

const callTool = (token: string | undefined, name: string) =>
  fetch(new URL("/mcp", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });

/**
 * Opens `/auth` for a client, like claude.ai's browser redirect. Returns the PKCE verifier and the
 * next hop.
 */
async function openAuth(client_id: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resource = `${base}/mcp`;
  const auth = await get(
    `/auth?${new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "mcp", resource }).toString()}`,
  );
  return { verifier, resource, location: auth.headers.get("location") ?? "" };
}

/** Registers a client and opens `/auth`. Returns the sign-in page URL and what the token call needs. */
async function startSignIn(name?: string) {
  const reg = await register(base, [REDIRECT], name ? { client_name: name } : {});
  assert.equal(reg.status, 201);
  const { client_id, client_secret } = (await reg.json()) as {
    client_id: string;
    client_secret: string;
  };
  const { verifier, resource, location } = await openAuth(client_id);
  assert.match(location, /\/interaction\//);
  return { client_id, client_secret, verifier, resource, location };
}

/** Follows redirects (sending the Access header only to `/interaction`) until the callback URL. */
async function followToCallback(start: string, header: Record<string, string>): Promise<string> {
  let location = start;
  for (let hops = 0; hops < 6 && !location.startsWith(REDIRECT); hops++) {
    const res = await get(location, location.includes("/interaction/") ? header : {});
    location = new URL(res.headers.get("location") ?? "", base).href;
  }
  return location;
}

test("registration refuses a redirect outside claude.ai", async () => {
  const res = await register(base, ["https://evil.example/cb"]);
  assert.equal(res.status, 400);
});

test("sign-in fails closed without a valid Access header, then works end to end", async () => {
  const { client_id, client_secret, verifier, resource, location } = await startSignIn();

  // Rule 3: no header, a header signed by another key, and the wrong email all get no further.
  assert.equal((await get(location)).status, 403);
  const forged = await app.sign({ email: "justin.anastos@gmail.com" }, app.otherKey);
  assert.equal((await get(location, { "cf-access-jwt-assertion": forged })).status, 403);
  const stranger = await app.sign({ email: "someone@example.com" });
  assert.equal((await get(location, { "cf-access-jwt-assertion": stranger })).status, 403);
  assert.equal((await postForm(location, { decision: "approve" })).status, 403);

  const good = await app.goodHeader();
  const page = await get(location, good);
  assert.equal(page.status, 200);
  const approved = await postForm(location, { decision: "approve" }, good);
  assert.equal(approved.status, 303);
  const callback = await followToCallback(approved.headers.get("location") ?? "", good);
  const code = new URL(callback).searchParams.get("code");
  assert.ok(code, `expected a code, ended at ${callback}`);

  const tokenRes = await post("/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id,
    client_secret,
    resource,
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.refresh_token, "expected a refresh token");

  assert.equal((await callTool(undefined, "health_check")).status, 401);
  assert.equal((await callTool("not-a-token", "health_check")).status, 401);
  const pong = await callTool(tokens.access_token, "health_check");
  assert.equal(pong.status, 200);
  assert.match(await pong.text(), /Groceries/);

  // Refresh tokens rotate: the old one fails after one use, and reuse revokes the whole grant.
  const refreshed = await post("/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id,
    client_secret,
  });
  assert.equal(refreshed.status, 200);
  const reused = await post("/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id,
    client_secret,
  });
  assert.equal(reused.status, 400);
  assert.equal((await callTool(tokens.access_token, "health_check")).status, 401);
});

test("a signed-in browser must tap Approve before any code is issued", async () => {
  const { location } = await startSignIn("Evil <b>Connector</b>");
  const good = await app.goodHeader();

  // Opening the link with a live Access session shows a page. It issues nothing.
  const page = await get(location, good);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /Evil &lt;b&gt;Connector&lt;\/b&gt;/, "the client name is shown, escaped");
  assert.match(html, /claude\.ai/, "the redirect host is shown");
  assert.match(html, /name="decision" value="approve"/);
  assert.match(html, /name="decision" value="deny"/);
  assert.equal(page.headers.get("location"), null);

  // Deny ends with access_denied and no code.
  const denied = await postForm(location, { decision: "deny" }, good);
  const callback = await followToCallback(denied.headers.get("location") ?? "", good);
  assert.ok(callback.startsWith(REDIRECT), `ended at ${callback}`);
  const params = new URL(callback).searchParams;
  assert.equal(params.get("error"), "access_denied");
  assert.equal(params.get("code"), null);
});

test("a sign-in with a live session and an earlier grant still needs Approve", async () => {
  const { client_id, client_secret, verifier, resource, location } = await startSignIn();
  const good = await app.goodHeader();
  const approved = await postForm(location, { decision: "approve" }, good);
  assert.equal(approved.status, 303);
  const first = await followToCallback(approved.headers.get("location") ?? "", good);
  const code = new URL(first).searchParams.get("code");
  assert.ok(code, `expected a code, ended at ${first}`);
  const tokenRes = await post("/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id,
    client_secret,
    resource,
  });
  assert.equal(tokenRes.status, 200);

  // The browser now holds the provider's session cookie, and the client has a grant. A second
  // /auth for the same client must still land on the Approve page, never go straight to claude.ai
  // with a code. Otherwise a link someone else made could sign their connector in silently.
  const again = await openAuth(client_id);
  assert.match(again.location, /\/interaction\//, `second sign-in went to ${again.location}`);
  const page = await get(again.location, good);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /name="decision" value="approve"/);

  // Approving the second time finishes in one tap and issues a working code: no resume loop.
  const approvedAgain = await postForm(again.location, { decision: "approve" }, good);
  assert.equal(approvedAgain.status, 303);
  const second = await followToCallback(approvedAgain.headers.get("location") ?? "", good);
  const secondCode = new URL(second).searchParams.get("code");
  assert.ok(secondCode, `expected a code, ended at ${second}`);
  const secondToken = await post("/token", {
    grant_type: "authorization_code",
    code: secondCode,
    code_verifier: again.verifier,
    redirect_uri: REDIRECT,
    client_id,
    client_secret,
    resource: again.resource,
  });
  assert.equal(secondToken.status, 200, await secondToken.text());
});

test("an Approve sent without the sign-in cookie, or after the link expired, gets the expired page", async () => {
  const { location } = await startSignIn();
  const good = await app.goodHeader();
  // A cross-site form post, or a tab opened long after: the Access header but no interaction cookie.
  const res = await fetch(new URL(location, base), {
    method: "POST",
    redirect: "manual",
    headers: good,
    body: new URLSearchParams({ decision: "approve" }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /This sign-in link has expired/);
});
