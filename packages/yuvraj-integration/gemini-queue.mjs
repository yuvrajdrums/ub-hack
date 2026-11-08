import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

/** Serialize per credential across processes, while separate Gemini keys run independently. */
export async function queuedGeminiFetch(url, init, apiKey, fetcher) {
  if (!apiKey) return fetcher(url, init);
  const directory = process.env.PANDA_DATA_DIR
    ? path.resolve(process.env.PANDA_DATA_DIR)
    : path.join(tmpdir(), "panda-gemini-queue");
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const lock = new DatabaseSync(path.join(directory, ".gemini-queue.sqlite"));
  const keyId = createHash("sha256").update(apiKey).digest("hex");
  const owner = randomUUID();
  let acquired = false;
  try {
    lock.exec("PRAGMA busy_timeout=0");
    lock.exec("CREATE TABLE IF NOT EXISTS gemini_key_locks (key_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    const claim = lock.prepare("INSERT INTO gemini_key_locks(key_id,owner,expires_at) VALUES(?,?,?) ON CONFLICT(key_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE gemini_key_locks.expires_at<=?");
    while (!acquired) {
      signal.throwIfAborted();
      try {
        lock.exec("BEGIN IMMEDIATE");
        const now = Date.now();
        acquired = claim.run(keyId, owner, now + 30_000, now).changes === 1;
        lock.exec("COMMIT");
      } catch (error) {
        try { lock.exec("ROLLBACK"); } catch {}
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
      }
      if (!acquired) {
        await delay(40, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    const response = await fetcher(url, { ...init, signal });
    // Hold this key's slot until the full reply is received.
    const body = response.body ? await response.arrayBuffer() : null;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    try {
      if (acquired) {
        lock.exec("BEGIN IMMEDIATE");
        lock.prepare("DELETE FROM gemini_key_locks WHERE key_id=? AND owner=?").run(keyId, owner);
        lock.exec("COMMIT");
      }
    } finally {
      lock.close();
    }
  }
}
import { createHash, randomUUID } from "node:crypto";
