import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Creates `dir` (and parents) readable only by this user. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * Writes `data` to a temp file beside `path`, then renames it over `path`. A crash leaves either
 * the old file or the new one, never half of one. The file is `0600`.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every earlier task with the same `key` has finished. Read-then-write file
 * updates use it so two callers cannot overwrite each other's change. A failed task does not block
 * the ones behind it.
 */
export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
