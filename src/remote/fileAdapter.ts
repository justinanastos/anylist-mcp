import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, AdapterPayload } from "oidc-provider";
import { serialized, writeFileAtomic } from "./files.ts";

type Entry = { payload: AdapterPayload; exp?: number };

export interface FileAdapterOptions {
  /** Most `Client` entries. A new client past this is refused. No limit when absent. */
  maxClients?: number;
}

/** A registered client with no Grant is dropped, when the cap is reached, after this long. */
const STALE_CLIENT_MS = 24 * 60 * 60 * 1000;

export type FileAdapter = ((name: string) => Adapter) & {
  /** How many entries a model holds. */
  count(name: string): Promise<number>;
  /**
   * Deletes clients that have no live Grant and were registered over 24 hours ago, with their
   * registration tokens. A client with a Grant is never deleted. Returns how many were deleted.
   */
  pruneStaleClients(): Promise<number>;
};

/**
 * Keeps each oidc-provider model in one `0600` JSON file under `data/oauth/`, so a restart keeps
 * claude.ai signed in. Writes to one file run one at a time, in order, and each writes the latest
 * state. Two saves can never finish out of order and leave an older snapshot on disk.
 */
export function fileAdapter(dir: string, options: FileAdapterOptions = {}): FileAdapter {
  const maxClients = options.maxClients ?? Number.POSITIVE_INFINITY;
  const caches = new Map<string, Promise<Map<string, Entry>>>();
  const fileOf = (name: string) => join(dir, `${name}.json`);
  const load = (name: string) => {
    let cache = caches.get(name);
    if (!cache) {
      cache = readFile(fileOf(name), "utf8").then(
        (text) => new Map(Object.entries(JSON.parse(text) as Record<string, Entry>)),
        () => new Map<string, Entry>(),
      );
      caches.set(name, cache);
    }
    return cache;
  };
  // The snapshot is taken when the write runs, not when it was asked for, so the last write on disk
  // always holds every change made before it.
  const save = (name: string, map: Map<string, Entry>) =>
    serialized(fileOf(name), async () => {
      const now = Date.now();
      for (const [id, entry] of map) if (entry.exp !== undefined && entry.exp < now) map.delete(id);
      await writeFileAtomic(fileOf(name), JSON.stringify(Object.fromEntries(map)));
    });
  const isLive = (entry: Entry) => entry.exp === undefined || entry.exp > Date.now();
  /** When oidc-provider registered the client. Unknown counts as now: never delete on a guess. */
  const issuedAtMs = (entry: Entry) => {
    const issued = entry.payload.client_id_issued_at;
    return typeof issued === "number" ? issued * 1000 : Date.now();
  };
  /** One synchronous pass over the loaded maps, then the saves. */
  const pruneStaleClients = async () => {
    const [clients, grants, tokens] = await Promise.all([
      load("Client"),
      load("Grant"),
      load("RegistrationAccessToken"),
    ]);
    const granted = new Set<unknown>();
    for (const entry of grants.values()) if (isLive(entry)) granted.add(entry.payload.clientId);
    const cutoff = Date.now() - STALE_CLIENT_MS;
    const dropped = new Set<string>();
    for (const [id, entry] of clients) {
      if (!granted.has(id) && issuedAtMs(entry) < cutoff) {
        clients.delete(id);
        dropped.add(id);
      }
    }
    if (dropped.size === 0) return 0;
    for (const [id, entry] of tokens) {
      if (typeof entry.payload.clientId === "string" && dropped.has(entry.payload.clientId)) {
        tokens.delete(id);
      }
    }
    await Promise.all([save("Client", clients), save("RegistrationAccessToken", tokens)]);
    return dropped.size;
  };
  const factory = (name: string): Adapter => {
    const live = async (id: string) => {
      const entry = (await load(name)).get(id);
      return entry && (entry.exp === undefined || entry.exp > Date.now())
        ? entry.payload
        : undefined;
    };
    const findBy = async (key: "uid" | "userCode", value: string) => {
      for (const [id, entry] of await load(name)) if (entry.payload[key] === value) return live(id);
      return undefined;
    };
    return {
      async upsert(id, payload, expiresIn) {
        const map = await load(name);
        if (name === "Client" && !map.has(id) && map.size >= maxClients) {
          // No route may register past the cap. Make room from stale clients first.
          await pruneStaleClients();
          // No await from here to `set`, so two registrations cannot both take the last place.
          if (map.size >= maxClients) throw new Error("Too many registered clients.");
        }
        map.set(id, { payload, ...(expiresIn ? { exp: Date.now() + expiresIn * 1000 } : {}) });
        await save(name, map);
      },
      find: live,
      findByUid: (uid) => findBy("uid", uid),
      findByUserCode: (code) => findBy("userCode", code),
      async consume(id) {
        const map = await load(name);
        const entry = map.get(id);
        if (entry) entry.payload.consumed = Math.floor(Date.now() / 1000);
        await save(name, map);
      },
      async destroy(id) {
        const map = await load(name);
        map.delete(id);
        await save(name, map);
      },
      async revokeByGrantId(grantId) {
        const map = await load(name);
        for (const [id, entry] of map) if (entry.payload.grantId === grantId) map.delete(id);
        await save(name, map);
      },
    };
  };
  return Object.assign(factory, {
    count: async (name: string) => (await load(name)).size,
    pruneStaleClients,
  });
}
