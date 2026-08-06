/** Guards the identity fallback that put a raw Slack id in the round table. */
const LOOKS_LIKE_AN_ID = /^[UWB][A-Z0-9]{6,}$/;

function personName(ctx: { user?: { name?: string } | null; actor: { name?: string; handle?: string } }): string {
  for (const candidate of [ctx.actor.name, ctx.actor.handle, ctx.user?.name]) {
    const value = candidate?.trim();
    if (value && !LOOKS_LIKE_AN_ID.test(value)) return value;
  }
  return "";
}
const personMarkdown = (name: string, id: string) => name || `<@${id}>`;

let fails = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};

// The reported bug: identifyUser:"platform" makes user.name the platform id.
t("prefers actor display name over the platform id",
  personName({ user: { name: "U06GTJE08F4" }, actor: { name: "Markus Ecker (CopilotKit)" } }),
  "Markus Ecker (CopilotKit)");

t("rejects a bare id even with no alternative",
  personName({ user: { name: "U06GTJE08F4" }, actor: {} }), "");

t("falls back to handle", personName({ user: null, actor: { handle: "markus" } }), "markus");
t("uses user.name when it is a real name", personName({ user: { name: "Martha" }, actor: {} }), "Martha");
t("ignores whitespace-only", personName({ user: { name: "   " }, actor: { name: " " } }), "");
t("bot ids rejected too", personName({ user: null, actor: { name: "B01ABCDEF" } }), "");
t("a short name that is not an id survives", personName({ user: null, actor: { name: "Uli" } }), "Uli");

// Markdown falls back to a mention; a real name never becomes a ping.
t("mention only without a name", personMarkdown("", "U06GTJE08F4"), "<@U06GTJE08F4>");
t("name is not turned into a ping", personMarkdown("Markus", "U06GTJE08F4"), "Markus");

// --- id extraction + item summary (appended) -------------------------------
function slackUserId(id: string): string | undefined {
  const last = id.split(":").pop()?.trim() ?? "";
  return /^[UW][A-Z0-9]{6,}$/.test(last) ? last : undefined;
}
const pm = (name: string, id: string) => {
  if (name) return name;
  const s = slackUserId(id);
  return s ? `<@${s}>` : id;
};
function summariseItems(items: string[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(", ");
}

// The reported case: composite id must yield a resolvable mention.
t("extracts the slack id from the composite", slackUserId("slack:unknown:U06GTJE08F4"), "U06GTJE08F4");
t("composite becomes a real mention", pm("", "slack:unknown:U06GTJE08F4"), "<@U06GTJE08F4>");
t("bare slack id also works", slackUserId("U06GTJE08F4"), "U06GTJE08F4");
t("non-slack id yields no mention", pm("", "teams:unknown:abc"), "teams:unknown:abc");
t("a known name still beats a mention", pm("Martha", "slack:unknown:U06GTJE08F4"), "Martha");

t("repeats collapse", summariseItems(["Tom Yum Soup", "Tom Yum Soup", "Spring Rolls (4)"]),
  "Tom Yum Soup x2, Spring Rolls (4)");
t("singles unchanged", summariseItems(["Pad Thai"]), "Pad Thai");
t("order preserved", summariseItems(["B", "A", "B"]), "B x2, A");

process.exit(fails ? 1 : 0);
