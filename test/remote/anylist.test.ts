import assert from "node:assert/strict";
import test from "node:test";
import { readAnyListCredentials, sharedClient, type Exec } from "../../src/remote/anylist.ts";

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

test("sharedClient logs in again after a failed call", async () => {
  let made = 0;
  const shared = sharedClient(creds, "Groceries", () => {
    made += 1;
    const id = made;
    return {
      id,
      targetList: null,
      connect: async () => {
        if (id === 1) throw new Error("Failed to connect to AnyList: session expired");
        return true;
      },
    } as never;
  });
  // A tool turns the throw into an error result, the way upstream's tools do.
  const result = await shared.guard(async () => {
    try {
      await (await shared.getClient()).connect();
      return { content: [{ type: "text", text: "ok" }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
  });
  assert.equal(result.isError, true);
  assert.equal(made, 1);
  const next = (await shared.getClient()) as unknown as Fake;
  assert.equal(next.id, 2);
  assert.equal(made, 2);
  // A good call keeps the client.
  await shared.guard(async () => ({ content: [{ type: "text", text: "fine" }] }));
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 2);
  // A thrown error drops it too, and the lock still lets the next call run.
  await assert.rejects(shared.guard(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(((await shared.getClient()) as unknown as Fake).id, 3);
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
