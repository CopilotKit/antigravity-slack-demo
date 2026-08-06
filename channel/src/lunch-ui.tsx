/**
 * The lunch round: rendering, per-person tracking, and the order gate.
 *
 * Split of responsibility with the agent:
 *
 *   agent/lunch.py   owns the *data* -- restaurants, menus, past orders
 *   this file        owns the *interaction* -- cards, clicks, state, confirm
 *
 * The model moves data from one side to the other: it calls a backend tool,
 * gets JSON back, and passes that JSON as arguments to a render tool here.
 * That is why these schemas restate the shape rather than importing it -- the
 * two halves run in different processes and different languages, and the model
 * is the wire between them.
 *
 * The round itself lives in Slack thread state (`thread.setState`), so it is
 * scoped to a thread, survives a worker restart, and needs no database. One
 * Slack thread is one lunch round.
 *
 * Adding an item is deliberately *not* an agent round trip. A click writes
 * state and acknowledges directly, so five people ordering is five instant
 * writes rather than five model turns.
 */

import {
  Actions,
  Button,
  Cell,
  Context,
  Divider,
  Field,
  Fields,
  Header,
  Image,
  Markdown,
  Message,
  Row,
  Section,
  Table,
  defineChannelComponent,
  defineChannelTool,
} from "@copilotkit/channels";
import type { Thread } from "@copilotkit/channels-ui";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Round state
// ---------------------------------------------------------------------------

/** One person's one item. Quantity is repetition, so removing is unambiguous. */
interface RoundItem {
  userId: string;
  userName: string;
  itemId: string;
  itemName: string;
  priceCents: number;
}

interface Round {
  restaurantId: string;
  restaurantName: string;
  items: RoundItem[];
  /** Set once placed, so a second confirm cannot double-order. */
  placedAt?: string;
  orderNumber?: string;
}

async function readRound(thread: Thread): Promise<Round | undefined> {
  return (await thread.state<Round>()) ?? undefined;
}

/** Slack ids: U/W for people, B for bots. Never a name anyone chose. */
const LOOKS_LIKE_AN_ID = /^[UWB][A-Z0-9]{6,}$/;

/**
 * Best human-readable name for whoever caused an event.
 *
 * `actor` first, deliberately. The channel runs with `identifyUser: "platform"`,
 * which makes the canonical `user.name` the *platform id* -- so preferring it
 * put "U06GTJE08F4" in the round table instead of a name. The provider's
 * display name lives on `actor`.
 *
 * Returns an empty string when nothing usable exists, leaving the caller to
 * decide: a table cell renders as raw_text and cannot show a mention, while
 * markdown can.
 */
function personName(ctx: {
  user?: { name?: string } | null;
  actor: { name?: string; handle?: string };
}): string {
  for (const candidate of [ctx.actor.name, ctx.actor.handle, ctx.user?.name]) {
    const value = candidate?.trim();
    if (value && !LOOKS_LIKE_AN_ID.test(value)) return value;
  }
  return "";
}

/**
 * How to refer to someone in *markdown*, where Slack resolves mentions.
 *
 * Only falls back to a mention when there is no name: a mention notifies, and
 * pinging someone every time they add a spring roll is not a feature.
 */
function personMarkdown(name: string, id: string): string {
  return name || `<@${id}>`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function totalCents(round: Round): number {
  return round.items.reduce((sum, item) => sum + item.priceCents, 0);
}

/**
 * Group a round by person, preserving the order people joined in.
 *
 * Sorting by name would reshuffle the table every time someone adds an item,
 * which reads as the bot losing track.
 */
function byPerson(
  round: Round,
): { id: string; name: string; items: string[]; cents: number }[] {
  const order: string[] = [];
  const seen = new Map<string, { id: string; name: string; items: string[]; cents: number }>();
  for (const item of round.items) {
    let entry = seen.get(item.userId);
    if (!entry) {
      entry = { id: item.userId, name: item.userName, items: [], cents: 0 };
      seen.set(item.userId, entry);
      order.push(item.userId);
    }
    // A later click may carry a name an earlier one lacked.
    if (!entry.name && item.userName) entry.name = item.userName;
    entry.items.push(item.itemName);
    entry.cents += item.priceCents;
  }
  return order.map((id) => seen.get(id)!);
}

// ---------------------------------------------------------------------------
// Schemas shared with the backend tools
// ---------------------------------------------------------------------------

const RESTAURANT = z.object({
  id: z.string(),
  name: z.string(),
  cuisine: z.string(),
  price_range: z.string(),
  eta_minutes: z.number(),
  rating: z.number(),
  blurb: z.string(),
  image: z.string(),
});

const MENU_ITEM = z.object({
  id: z.string(),
  name: z.string(),
  price_cents: z.number().int(),
  description: z.string(),
  image: z.string(),
  tags: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Show the places the office can order from.
 *
 * A component, not a tool: it only renders, so the SDK can own posting. The
 * "Choose" buttons are a shortcut -- picking is meant to be conversational,
 * and the agent should be able to act on "let's do thai" just as well.
 */
export const ShowRestaurants = defineChannelComponent({
  name: "show_restaurants",
  description:
    "Display restaurant options as cards. Call search_restaurants first and " +
    "pass its results here unchanged. Say something about the options in your " +
    "own words too - the cards are for scanning, you are for advising. Do not " +
    "make people click: if they reply 'the thai place' or 'something fast', " +
    "just act on it.",
  parameters: z.object({
    restaurants: z.array(RESTAURANT).min(1).max(6),
  }),
  render({ restaurants }) {
    return (
      <Message>
        <Header>Where are we ordering from?</Header>
        {restaurants.map((r, index) => [
          index > 0 ? <Divider /> : null,
          <Section>
            <Markdown>{`*${r.name}*`}</Markdown>
          </Section>,
          <Image url={r.image} alt={`${r.cuisine} food from ${r.name}`} />,
          <Fields>
            <Field label="Cuisine">{r.cuisine}</Field>
            <Field label="Price">{r.price_range}</Field>
            <Field label="Ready in">{`~${r.eta_minutes} min`}</Field>
            <Field label="Rating">{r.rating.toFixed(1)}</Field>
          </Fields>,
          <Section>
            <Markdown>{r.blurb}</Markdown>
          </Section>,
          <Actions>
            {/* A registered component binds handlers by JSX key, not by tree
                position, so that a click still resolves after a restart. The
                key is required and must be unique: without it the whole
                render throws inside the run loop, which posts nothing and
                logs nothing. */}
            <Button
              key={`choose-${r.id}`}
              value={`${r.id}|${r.name}`}
              onClick={async (ctx) => {
                const [, name] = String(ctx.action.value).split("|");
                await ctx.thread.runAgent({
                  prompt: `Let's order from ${name}. Show me the menu.`,
                });
              }}
            >
              {`Choose ${r.name}`}
            </Button>
          </Actions>,
        ])}
        <Context>Or just say which one you fancy.</Context>
      </Message>
    );
  },
});

/**
 * Show a menu, with an Add button per dish.
 *
 * A tool rather than a component because it opens the round: picking the
 * restaurant is what starts one, and that is a state write.
 */
export const ShowMenu = defineChannelTool({
  name: "show_menu",
  description:
    "Display a restaurant's menu as cards people can add from, and open the " +
    "lunch round for that restaurant. Call get_menu first and pass its " +
    "restaurant and items here unchanged. Switching restaurants mid-round " +
    "clears what people already picked, so confirm before doing that.",
  parameters: z.object({
    restaurant: RESTAURANT,
    items: z.array(MENU_ITEM).min(1).max(12),
  }),
  async handler({ restaurant, items }, { thread }) {
    const existing = await readRound(thread);
    if (existing?.placedAt) {
      return `The ${existing.restaurantName} order was already placed (${existing.orderNumber}). Tell the user, and ask whether they want to start a fresh round before showing another menu.`;
    }

    const switching =
      existing && existing.restaurantId !== restaurant.id && existing.items.length > 0;

    await thread.setState<Round>({
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      // Picks belong to a restaurant; carrying them across would order the
      // wrong food from the right place.
      items: existing && existing.restaurantId === restaurant.id ? existing.items : [],
    });

    await thread.post(
      <Message>
        <Header>{`${restaurant.name} — menu`}</Header>
        {items.map((item, index) => [
          index > 0 ? <Divider /> : null,
          <Section>
            <Markdown>{`*${item.name}* — ${money(item.price_cents)}`}</Markdown>
          </Section>,
          <Image url={item.image} alt={item.name} />,
          <Section>
            <Markdown>
              {item.tags?.length
                ? `${item.description}\n_${item.tags.join(" · ")}_`
                : item.description}
            </Markdown>
          </Section>,
          <Actions>
            <Button
              value={`${item.id}|${item.name}|${item.price_cents}`}
              onClick={async (ctx) => {
                const [itemId, itemName, cents] = String(ctx.action.value).split("|");
                const round = await readRound(ctx.thread);
                if (!round) return;
                if (round.placedAt) {
                  await ctx.thread.post(
                    <Message>
                      <Context>
                        {`That order already went in (${round.orderNumber}) — too late to add ${itemName}.`}
                      </Context>
                    </Message>,
                  );
                  return;
                }
                const whoId = ctx.user?.id ?? ctx.actor.id;
                const who = personName(ctx);
                round.items.push({
                  userId: whoId,
                  userName: who,
                  itemId,
                  itemName,
                  priceCents: Number(cents),
                });
                await ctx.thread.setState<Round>(round);
                await ctx.thread.post(
                  <Message>
                    <Context>
                      {`${personMarkdown(who, whoId)} added ${itemName} — ${round.items.length} item${round.items.length === 1 ? "" : "s"} in the round.`}
                    </Context>
                  </Message>,
                );
              }}
            >
              Add
            </Button>
          </Actions>,
        ])}
        <Context>Tap Add as many times as you like. Ask me for the round when you want the total.</Context>
      </Message>,
    );

    return (
      `Opened a lunch round for ${restaurant.name} and posted the menu.` +
      (switching ? ` Cleared the previous ${existing!.restaurantName} picks.` : "") +
      " People add items by clicking, which does not involve you - do not add anything on their behalf, and do not list the menu again in text."
    );
  },
});

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

/** Show who has ordered what so far. */
export const ShowRound = defineChannelTool({
  name: "show_round",
  description:
    "Show the current lunch round: who ordered what, and the total. Use this " +
    "when someone asks what the order looks like, who is in, or what it costs.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const round = await readRound(thread);
    if (!round || round.items.length === 0) {
      return round
        ? `The round is open for ${round.restaurantName} but nobody has added anything yet. Tell them to add items from the menu above.`
        : "There is no lunch round open yet. Suggest somewhere to order from first.";
    }

    const people = byPerson(round);
    const total = totalCents(round);

    await thread.post(
      <Message>
        <Header>{`${round.restaurantName} — the round so far`}</Header>
        <Table
          columns={[{ header: "Who" }, { header: "Order" }, { header: "Subtotal" }]}
        >
          {people.map((p) => (
            <Row>
              {/* Slack table cells are raw_text, so a <@id> mention would show
                  literally. Without a name the bare id is the honest option. */}
              <Cell>{p.name || p.id}</Cell>
              <Cell>{p.items.join(", ")}</Cell>
              <Cell>{money(p.cents)}</Cell>
            </Row>
          ))}
        </Table>
        <Fields>
          <Field label="People">{String(people.length)}</Field>
          <Field label="Items">{String(round.items.length)}</Field>
          <Field label="Total">{money(total)}</Field>
        </Fields>
        {round.placedAt ? (
          <Context>{`Placed — order ${round.orderNumber}.`}</Context>
        ) : (
          <Context>Say "place the order" when everyone is in.</Context>
        )}
      </Message>,
    );

    return `Posted the round: ${people.length} people, ${round.items.length} items, ${money(total)} total, from ${round.restaurantName}${round.placedAt ? `, already placed as ${round.orderNumber}` : ", not yet placed"}. Summarise in one line; do not repeat the table.`;
  },
});

/**
 * Ask for confirmation, then place.
 *
 * The gate is the point. Nothing here spends real money today, but this is the
 * seam where a real ordering backend would go, and by then the difference
 * between "the agent proposed an order" and "the agent bought lunch for nine
 * people" has to be a human click.
 */
export const ConfirmOrder = defineChannelTool({
  name: "confirm_order",
  description:
    "Ask the office to confirm the lunch round, then place it. This does NOT " +
    "place the order itself - it posts a summary with a confirm button and " +
    "ends your turn. Never claim the order is placed after calling this; wait " +
    "to be told. Use it when someone says to order, send it, or place it.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const round = await readRound(thread);
    if (!round || round.items.length === 0) {
      return "Nothing to order - the round is empty. Say so instead of confirming.";
    }
    if (round.placedAt) {
      return `Already placed as ${round.orderNumber}. Say so; do not offer to place it again.`;
    }

    const people = byPerson(round);
    const total = totalCents(round);

    await thread.post(
      <Message accent="#E01E5A">
        <Header>Place this order?</Header>
        <Section>
          <Markdown>
            {`*${round.restaurantName}* — ${round.items.length} items for ${people.length} ${people.length === 1 ? "person" : "people"}, *${money(total)}* total.`}
          </Markdown>
        </Section>
        <Section>
          <Markdown>
            {people
              .map((p) => `• ${personMarkdown(p.name, p.id)}: ${p.items.join(", ")}`)
              .join("\n")}
          </Markdown>
        </Section>
        <Actions>
          <Button
            style="primary"
            value="place"
            onClick={async (ctx) => {
              const current = await readRound(ctx.thread);
              if (!current) return;
              // Re-check rather than trust the click: two people can hit
              // confirm on the same message before either write lands.
              if (current.placedAt) {
                await ctx.thread.post(
                  <Message>
                    <Context>{`Already placed — order ${current.orderNumber}.`}</Context>
                  </Message>,
                );
                return;
              }
              const orderNumber = `LN-${Math.abs(
                [...current.items.map((i) => i.itemId), current.restaurantId]
                  .join()
                  .split("")
                  .reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
              )
                .toString(36)
                .toUpperCase()
                .slice(0, 6)}`;
              current.placedAt = new Date().toISOString();
              current.orderNumber = orderNumber;
              await ctx.thread.setState<Round>(current);
              const who = personName(ctx) || "Someone";
              await ctx.thread.post(
                <Message accent="#2EB67D">
                  <Header>Order placed</Header>
                  <Fields>
                    <Field label="Restaurant">{current.restaurantName}</Field>
                    <Field label="Order">{orderNumber}</Field>
                    <Field label="Total">{money(totalCents(current))}</Field>
                    <Field label="Confirmed by">{who}</Field>
                  </Fields>
                  <Context>
                    Simulated — this demo has no ordering backend, so no food is on its way.
                  </Context>
                </Message>,
              );
            }}
          >
            Place order
          </Button>
          <Button
            style="danger"
            value="cancel"
            onClick={async (ctx) => {
              await ctx.thread.post(
                <Message>
                  <Context>
                    {`${personName(ctx) || "Someone"} cancelled — the round is still open.`}
                  </Context>
                </Message>,
              );
            }}
          >
            Cancel
          </Button>
        </Actions>
      </Message>,
    );

    return `Posted the confirmation for ${round.restaurantName}, ${money(total)}. Your turn ends here - someone has to click. Do not say the order is placed.`;
  },
});

export const LUNCH_COMPONENTS = [ShowRestaurants];
export const LUNCH_TOOLS = [ShowMenu, ShowRound, ConfirmOrder];
