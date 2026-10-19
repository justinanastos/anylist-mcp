import { execFile } from "node:child_process";
// The upstream files are plain JavaScript with no types.
// @ts-expect-error TS7016
import UpstreamClient from "../anylist-client.js";

/** What the tools use of an AnyList client. */
export interface AnyListClient {
  connect(listName?: string | null): Promise<boolean>;
  targetList: { name: string } | null;
}
const AnyListClient = UpstreamClient as new (options: ClientOptions) => AnyListClient;

export type GetClient = () => Promise<AnyListClient>;
/** Runs `job` after every earlier job has finished. */
export type Guard = <T>(job: () => Promise<T>) => Promise<T>;
export type Credentials = { username: string; password: string };
/** Test seam for `execFile`. */
export type Exec = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout: string) => void,
) => void;

const realExec: Exec = (file, args, callback) => {
  execFile(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
    callback(error, String(stdout)),
  );
};

/**
 * Reads the AnyList login from 1Password. The error text never holds anything `op` printed, so a
 * secret cannot reach a log through it.
 */
export function readAnyListCredentials(exec: Exec = realExec): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    exec(
      "op",
      [
        "item", "get", "AnyList", "--vault", "Mac Mini",
        "--fields", "label=username,label=password",
        "--format", "json",
      ],
      (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          reject(new Error(`could not read the AnyList item from 1Password (op exit ${String(code ?? "?")})`));
          return;
        }
        let fields: unknown;
        try {
          fields = JSON.parse(stdout);
        } catch {
          reject(new Error("1Password returned something that is not JSON"));
          return;
        }
        const list = (Array.isArray(fields) ? fields : [fields]) as Array<Record<string, unknown>>;
        // `op` matches `label=username` to the field whose id is `username`, whatever its label says.
        const pick = (id: string, purpose: string): string => {
          const field = list.find((f) => f?.id === id || f?.purpose === purpose);
          return typeof field?.value === "string" ? field.value : "";
        };
        const username = pick("username", "USERNAME");
        const password = pick("password", "PASSWORD");
        if (!username || !password) {
          reject(new Error("the AnyList item in 1Password has no username or password"));
          return;
        }
        resolve({ username, password });
      },
    );
  });
}

type ClientOptions = { username: string; password: string; defaultListName?: string };

/**
 * One AnyList client for the whole server, and a lock so tool calls run one at a time (`connect`
 * changes which list the client points at). The client is dropped after a call that failed to
 * connect or threw, so the next call logs in again instead of failing until a restart.
 */
export function sharedClient(
  creds: Credentials,
  defaultListName?: string,
  make: (options: ClientOptions) => AnyListClient = (o) => new AnyListClient(o),
): { getClient: GetClient; guard: Guard; drop: () => void } {
  let client: AnyListClient | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const getClient: GetClient = async () => {
    client ??= make({
      username: creds.username,
      password: creds.password,
      ...(defaultListName ? { defaultListName } : {}),
    });
    return client;
  };
  const drop = () => {
    client = null;
  };
  const failedToConnect = (result: unknown): boolean => {
    const r = result as { isError?: unknown; content?: Array<{ text?: unknown }> } | null;
    const text = r?.content?.[0]?.text;
    return r?.isError === true && typeof text === "string" && text.startsWith("Failed to connect");
  };

  const guard: Guard = (job) => {
    const run = async () => {
      try {
        const result = await job();
        if (failedToConnect(result)) drop();
        return result;
      } catch (error) {
        drop();
        throw error;
      }
    };
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  return { getClient, guard, drop };
}
