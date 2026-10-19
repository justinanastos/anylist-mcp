import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `body{font:16px/1.4 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}
h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.4rem;border-radius:.5rem;border:1px solid #888;background:#f4f4f4;margin-right:.6rem}
button.go{background:#1a56c4;color:#fff;border-color:#1a56c4}.muted{color:#666}code{background:#eee;padding:0 .25rem}`;

/** A whole HTML page. `body` is trusted markup: escape every dynamic value before it gets here. */
export function htmlPage(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}${extraStyle}</style></head><body>${body}</body></html>`;
}

/**
 * Sends HTML that cannot be framed (so nobody can overlay a button), cannot run script, and is
 * never cached.
 */
export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}

export class BodyTooLarge extends Error {}

/** Reads a request body, refusing more than `maxBytes` however the sender frames it. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Allows `limit` events in any `windowMs`. In memory, so a restart resets it. */
export class RateLimit {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #events: number[] = [];

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Takes one place in the window, in one synchronous step, so a burst of callers cannot all pass.
   * Returns `{ wait: 0, release }` when a place was taken. `release` gives it back (for an attempt
   * that created nothing). Returns `{ wait }` in seconds, with no place taken, when the window is
   * full.
   */
  tryAcquire(): { wait: number; release: () => void } {
    const cutoff = this.#now() - this.#windowMs;
    this.#events = this.#events.filter((at) => at > cutoff);
    if (this.#events.length >= this.#limit) {
      const oldest = this.#events[0] ?? this.#now();
      const wait = Math.max(1, Math.ceil((oldest + this.#windowMs - this.#now()) / 1000));
      return { wait, release: () => undefined };
    }
    const at = this.#now();
    this.#events.push(at);
    return {
      wait: 0,
      release: () => {
        const index = this.#events.indexOf(at);
        if (index !== -1) this.#events.splice(index, 1);
      },
    };
  }
}
