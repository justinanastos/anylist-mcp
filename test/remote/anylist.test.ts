import assert from "node:assert/strict";
import test from "node:test";
import { readAnyListCredentials, sharedClient, type Exec } from "../../src/remote/anylist.ts";
import { lockTools } from "../../src/remote/server.ts";
// @ts-expect-error TS7016: upstream tools are plain JavaScript with no types.
import { register as registerRecipes } from "../../src/tools/recipes.js";

type Fake = { id: number; connect(list?: string | null): Promise<boolean>; targetList: { name: string } | null };
const creds = { username: "u@example.com", password: "hunter2-secret" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("sharedClient runs calls one at a time", async () => {
  const shared = sharedClient(creds, undefined, () => ({ id: 1 }) as never);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = shared.guard(async () => {
    const client = (await shared.getClient()) as unknown as Fake;
    client.targetList = { name: "Groceries" };
    events.push("first start");
    await gate;
    // The second call has not touched the shared client yet.
    events.push(`first ends on ${client.targetList?.name}`);
  });
  const second = shared.guard(async () => {
    const client = (await shared.getClient()) as unknown as Fake;
    events.push("second start");
    client.targetList = { name: "Costco" };
  });
  await tick();
  await tick();
  assert.deepEqual(events, ["first start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first start", "first ends on Groceries", "second start"]);
});

type Result = { isError?: boolean; content: Array<{ text: string }> };
const okResult = (text: string): Result => ({ content: [{ text }] });

test("sharedClient logs in again after a real tool fails to connect", async () => {
  let made = 0;
  const shared = sharedClient(creds, "Groceries", () => {
    made += 1;
    const id = made;
    return {
      id,
      targetList: null,
      connect: async () => {
        // The wording of the real client's connect().
        if (id === 1) throw new Error("Failed to connect to AnyList: session expired");
        return true;
      },
      getRecipes: async () => [],
    } as never;
  });
  // The real recipes tool turns the throw into "Recipes list failed: Failed to connect to ...".
  let handler!: (params: unknown) => Promise<Result>;
  registerRecipes(
    { registerTool: (_n: string, _s: unknown, h: typeof handler) => (handler = h), server: { getClientCapabilities: () => null } },
    shared.getClient,
  );
  const result = await shared.guard(() => handler({ action: "list" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /^Recipes list failed: Failed to connect to AnyList/);
  assert.equal(made, 1);
  const next = (await shared.getClient()) as unknown as Fake;
  assert.equal(next.id, 2);
  assert.equal(made, 2);
  // A good call keeps the client.
  await shared.guard(async () => okResult("fine"));
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 2);
  // A thrown error drops it too, and the lock still lets the next call run.
  await assert.rejects(shared.guard(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 3);
});

test("sharedClient answers, drops the client and frees the lock when a job hangs", async () => {
  let made = 0;
  let disconnected = 0;
  const shared = sharedClient(
    creds,
    undefined,
    () => {
      made += 1;
      return { id: made, disconnect: async () => { disconnected += 1; } } as never;
    },
    { timeoutMs: 20 },
  );
  await shared.getClient();
  const result = (await shared.guard(() => new Promise<Result>(() => {}))) as Result;
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "AnyList didn't answer in 90 seconds; try again.");
  assert.equal(disconnected, 1);
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 2);
  // The lock is free: the next job runs.
  assert.equal(((await shared.guard(async () => okResult("next"))) as Result).content[0]!.text, "next");
});

test("sharedClient disconnects the old client on drop, even if disconnect throws", async () => {
  const calls: string[] = [];
  let made = 0;
  const shared = sharedClient(creds, undefined, () => {
    made += 1;
    const id = made;
    return {
      id,
      disconnect: async () => {
        calls.push(`disconnect ${id}`);
        throw new Error("already closed");
      },
    } as never;
  });
  await shared.getClient();
  shared.drop();
  await tick();
  assert.deepEqual(calls, ["disconnect 1"]);
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 2);
});

test("lockTools makes every registered tool hold the lock for its whole run", async () => {
  const shared = sharedClient(creds, undefined, () => ({ id: 1 }) as never);
  const handlers: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: (...a: unknown[]) => Promise<unknown>) => {
      handlers[name] = handler;
    },
  };
  lockTools(server as never, shared.guard);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  server.registerTool("a", {}, async () => {
    events.push("a start");
    await gate;
    events.push("a end");
    return okResult("a");
  });
  server.registerTool("b", {}, async () => {
    events.push("b start");
    events.push("b end");
    return okResult("b");
  });
  const first = handlers.a!();
  const second = handlers.b!();
  await tick();
  await tick();
  assert.deepEqual(events, ["a start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a start", "a end", "b start", "b end"]);
});

test("readAnyListCredentials never puts the password in an error message", async () => {
  const secret = "hunter2-secret";
  const failing: Exec = (_file, _args, callback) => {
    callback(Object.assign(new Error(`op failed, password was ${secret}`), { code: 1 }), secret);
  };
  await assert.rejects(readAnyListCredentials(failing), (error: Error) => {
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const garbage: Exec = (_file, _args, callback) => callback(null, `not json ${secret}`);
  await assert.rejects(readAnyListCredentials(garbage), (error: Error) => !error.message.includes(secret));
  // Reads username and password by field id, as `op` prints them.
  const good: Exec = (_file, _args, callback) =>
    callback(
      null,
      JSON.stringify([
        { id: "username", purpose: "USERNAME", label: "sign_in_email", value: "u@example.com" },
        { id: "password", purpose: "PASSWORD", label: "sign_in_pw", value: secret },
      ]),
    );
  assert.deepEqual(await readAnyListCredentials(good), { username: "u@example.com", password: secret });
});
