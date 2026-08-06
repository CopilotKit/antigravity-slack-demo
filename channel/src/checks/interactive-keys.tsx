/** Reproduces the registry's requireKeys guard against our real components. */
import { renderToIR } from "@copilotkit/channels-ui";
import { ShowRestaurants } from "../lunch-ui.js";
import { ShowTable } from "../ui-tools.js";

const EVENT_PROPS = ["onClick", "onSelect", "onSubmit", "onReaction"];

/** Mirrors ActionRegistry.walk's requireKeys branch. */
function checkKeys(nodes: any[], seen = new Set<string>(), path = "root"): string[] {
  const errs: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const here = `${path}[${i}]:${node.type}`;
    const evented = EVENT_PROPS.filter((p) => typeof node.props?.[p] === "function");
    if (evented.length > 0) {
      const k = node.key;
      if (k === undefined || (typeof k === "string" && !k.trim())) {
        errs.push(`${here}.${evented[0]} has NO KEY`);
      } else if (seen.has(k)) {
        errs.push(`${here} DUPLICATE key "${k}"`);
      } else seen.add(k);
    }
    for (const [name, v] of Object.entries(node.props ?? {})) {
      const kids = Array.isArray(v) ? v : [v];
      const nested = kids.filter((c: any) => c && typeof c === "object" && "type" in c && "props" in c);
      if (nested.length) errs.push(...checkKeys(nested as any[], seen, `${here}.${name}`));
    }
  }
  return errs;
}

const RS = ["bangkok-kitchen", "nonna-rosa", "ballard-burger", "emerald-greens"].map((id, i) => ({
  id, name: `R${i}`, cuisine: "Thai", price_range: "$$", eta_minutes: 30, rating: 4.5,
  blurb: "blurb", image: "https://example.com/a.jpg",
}));

let bad = 0;
for (const [label, tree] of [
  ["show_restaurants", ShowRestaurants.render({ restaurants: RS } as any, {} as any)],
  ["show_table", ShowTable.render({ columns: ["A","B"], rows: [["1","2"]] } as any, {} as any)],
] as const) {
  const errs = checkKeys(renderToIR(tree as any) as any[]);
  console.log(errs.length ? `FAIL ${label}:\n   ${errs.join("\n   ")}` : `PASS ${label} — all interactive nodes keyed & unique`);
  bad += errs.length;
}
process.exit(bad ? 1 : 0);
