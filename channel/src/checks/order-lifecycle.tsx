/** Drives the real cancel_order handler through the place/cancel state machine. */
import { CancelOrder, mintOrderNumber, removeLine } from "../lunch-ui.js";

type Round = Record<string, any>;

/** Minimal Thread stand-in: the handler only needs state + post. */
function fakeThread(initial?: Round) {
  let state: Round | undefined = initial;
  const posts: string[] = [];
  return {
    posts,
    get state_() { return state; },
    thread: {
      state: async () => state,
      setState: async (v: Round) => { state = v; },
      post: async (ui: unknown) => {
        posts.push(JSON.stringify(ui));
        return {} as never;
      },
    } as any,
  };
}

const ctx = (t: any) => ({ thread: t, user: null, actor: { name: "Martha" }, platform: "slack" }) as any;
const placedRound = (): Round => ({
  restaurantId: "bangkok-kitchen",
  restaurantName: "Bangkok Kitchen",
  items: [
    { lineId: "L1", userId: "u1", userName: "Martha", itemId: "bk-pad-thai", itemName: "Pad Thai", priceCents: 1650 },
    { lineId: "L2", userId: "u2", userName: "Jordan", itemId: "bk-tom-yum", itemName: "Tom Yum Soup", priceCents: 1100 },
  ],
  placedAt: "2026-08-06T10:00:00.000Z",
  orderNumber: "LN-ABC123",
  attempts: 1,
});

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) fails++;
};

// 1. Cancelling a placed order reopens the round and keeps the picks.
{
  const f = fakeThread(placedRound());
  const msg = await CancelOrder.handler({}, ctx(f.thread));
  const s = f.state_!;
  check("cancel reopens the round", !s.placedAt && !!s.cancelledAt, JSON.stringify(s));
  check("picks survive cancellation", s.items.length === 2, `${s.items.length} items`);
  check("posts a cancellation message", f.posts.length === 1, `${f.posts.length} posts`);
  check("tells the model what happened", String(msg).includes("LN-ABC123"), String(msg));
}

// 2. Cancelling twice must not pretend to cancel again.
{
  const f = fakeThread(placedRound());
  await CancelOrder.handler({}, ctx(f.thread));
  const before = f.posts.length;
  const msg = await CancelOrder.handler({}, ctx(f.thread));
  check("second cancel is a no-op", f.posts.length === before, `${f.posts.length} posts`);
  check("second cancel says already cancelled", String(msg).toLowerCase().includes("already"), String(msg));
}

// 3. Cancelling before anything is placed must not wipe the round.
{
  const open = placedRound(); delete open.placedAt; delete open.orderNumber;
  const f = fakeThread(open);
  const msg = await CancelOrder.handler({}, ctx(f.thread));
  check("nothing placed => nothing cancelled", f.state_!.items.length === 2 && !f.state_!.cancelledAt, JSON.stringify(f.state_));
  check("says nothing was placed", String(msg).toLowerCase().includes("nothing has been placed"), String(msg));
}

// 4. No round at all.
{
  const f = fakeThread(undefined);
  const msg = await CancelOrder.handler({}, ctx(f.thread));
  check("no round is handled", String(msg).toLowerCase().includes("no lunch round"), String(msg));
}

// 5. Re-placing an unchanged cart must not reuse the cancelled number.
{
  const ids = ["bk-pad-thai", "bk-tom-yum"];
  const first = mintOrderNumber(ids, "bangkok-kitchen", 1);
  const second = mintOrderNumber(ids, "bangkok-kitchen", 2);
  check("re-place mints a new number", first !== second, `${first} vs ${second}`);
  check("same attempt is stable", mintOrderNumber(ids, "bangkok-kitchen", 1) === first);
  check("number looks quotable", /^LN-[0-9A-Z]{1,6}$/.test(first), first);
}

// 6. Removing one line takes out that line only.
{
  const open = placedRound(); delete open.placedAt; delete open.orderNumber;
  open.items.push({ lineId: "L3", userId: "u1", userName: "Martha", itemId: "bk-pad-thai", itemName: "Pad Thai", priceCents: 1650 });
  const f = fakeThread(open);
  await removeLine({ ...ctx(f.thread), thread: f.thread } as any, "L1", "Pad Thai");
  const left = f.state_!.items.map((i: any) => i.lineId);
  check("removes the clicked line", !left.includes("L1"), left.join(","));
  check("its identical twin survives", left.includes("L3"), left.join(","));
  check("other people untouched", left.includes("L2"), left.join(","));
}

// 7. Removing the same line twice is not a double-removal.
{
  const open = placedRound(); delete open.placedAt; delete open.orderNumber;
  const f = fakeThread(open);
  await removeLine({ ...ctx(f.thread), thread: f.thread } as any, "L1", "Pad Thai");
  const after = f.state_!.items.length;
  await removeLine({ ...ctx(f.thread), thread: f.thread } as any, "L1", "Pad Thai");
  check("second remove is a no-op", f.state_!.items.length === after, `${f.state_!.items.length} items`);
  check("says it was already removed", f.posts.at(-1)!.includes("already removed"), f.posts.at(-1)!);
}

// 8. Removing after placing must not alter a placed order.
{
  const f = fakeThread(placedRound());
  await removeLine({ ...ctx(f.thread), thread: f.thread } as any, "L1", "Pad Thai");
  check("placed order is immutable", f.state_!.items.length === 2, `${f.state_!.items.length} items`);
  check("says it is too late", f.posts.at(-1)!.includes("too late"), f.posts.at(-1)!);
}

process.exit(fails ? 1 : 0);
