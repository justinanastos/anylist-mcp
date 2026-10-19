export function errorResponse(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function textResponse(msg) {
  return { content: [{ type: "text", text: msg }] };
}

export function requireParams(params, required, action) {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      throw new Error(`Action "${action}" requires parameter "${key}"`);
    }
  }
}

/**
 * Shared formatter for batch writes. `results` is [{ ok, text }], one per change.
 * One line per change; isError only when every change failed.
 */
export function batchResponse(results) {
  const text = results.map(r => r.text).join("\n");
  const allFailed = results.length > 0 && results.every(r => !r.ok);
  return allFailed ? errorResponse(text) : textResponse(text);
}

/**
 * Run `fn(entry)` for each entry in order. `fn` returns the success line;
 * a thrown error becomes `failed <label(entry)>: <reason>`.
 */
export async function runBatch(entries, label, fn) {
  const results = [];
  for (const entry of entries) {
    try {
      results.push({ ok: true, text: await fn(entry) });
    } catch (error) {
      results.push({ ok: false, text: `failed ${label(entry)}: ${error.message}` });
    }
  }
  return batchResponse(results);
}
