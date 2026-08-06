/** Verifies the shutdown drain: waits for in-flight runs, but is bounded. */
const inFlight = new Set<Promise<unknown>>();
const DRAIN_MS = 300; // scaled down from 20s for the test

async function traced(label: string, run: () => Promise<unknown>): Promise<void> {
  const settled = Promise.resolve().then(run);
  inFlight.add(settled);
  try { await settled; } catch { /* logged in the real one */ }
  finally { inFlight.delete(settled); }
}

async function drain(): Promise<{ waitedMs: number; leftover: number }> {
  const started = Date.now();
  if (inFlight.size === 0) return { waitedMs: 0, leftover: 0 };
  const finished = Promise.allSettled([...inFlight]);
  const deadline = new Promise<void>((r) => { setTimeout(r, DRAIN_MS).unref(); });
  await Promise.race([finished, deadline]);
  return { waitedMs: Date.now() - started, leftover: inFlight.size };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) fails++;
};

// 1. Nothing running: returns immediately.
check("idle exits at once", (await drain()).waitedMs < 50, "no wait");

// 2. A short run is awaited to completion (the bug: this used to be abandoned).
let done = false;
void traced("short", async () => { await sleep(120); done = true; });
let r = await drain();
check("waits for an in-flight run", done && r.leftover === 0, `waited ${r.waitedMs}ms, finished=${done}`);

// 3. A run that overruns the budget does not hang shutdown.
void traced("hung", async () => { await sleep(5_000); });
r = await drain();
check("bounded by the deadline", r.waitedMs < DRAIN_MS + 150 && r.leftover === 1,
      `waited ${r.waitedMs}ms, ${r.leftover} still running`);

// 4. A failing run must not cut the wait short for a healthy sibling.
let sibling = false;
void traced("boom", async () => { throw new Error("nope"); });
void traced("ok", async () => { await sleep(120); sibling = true; });
r = await drain();
check("one failure does not abandon the rest", sibling, `sibling finished=${sibling}`);

process.exit(fails ? 1 : 0);
