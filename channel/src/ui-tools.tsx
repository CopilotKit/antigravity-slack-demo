/**
 * Rich UI the agent can drive itself.
 *
 * The agent is a plain AG-UI agent: it emits text and tool calls, and has no
 * idea what Slack is. Anything richer than text therefore has to arrive as a
 * *tool* — the channel registers UI here, the SDK turns each entry into a tool
 * descriptor passed to the agent on every run, and the Antigravity adapter
 * exposes it to the model as a client-side tool that parks until this side
 * answers.
 *
 * The round trip, once per rendered element:
 *
 *   model calls show_image
 *     → adapter parks the call, ends the run (RUN_FINISHED)
 *     → the channel run loop executes the handler here, posts Block Kit
 *     → the handler's return value goes back as the tool result
 *     → the adapter unparks and the model continues
 *
 * Two constraints shaped what is in this file, both verified against the
 * installed packages rather than assumed:
 *
 * 1. **No blocking pickers.** `Thread.awaitChoice()` rejects outright on
 *    managed Channels — `channels-intelligence` declares
 *    `supportsBlockingChoice: false`. So `ask_choice` cannot wait for the
 *    click; it posts, returns, and the click re-enters the agent as a new user
 *    turn.
 * 2. **No charts.** The Slack Block Kit renderer has cases for image, table,
 *    actions, button, select and input, but none for `chart`. The renderer is
 *    total, so a `<Chart>` is *skipped silently* — it would look like the agent
 *    ignored the request. Structured numbers go through `show_table` instead.
 */

import {
  Actions,
  Button,
  Cell,
  Context,
  Image,
  Markdown,
  Message,
  Row,
  Section,
  Select,
  Table,
  defineChannelComponent,
  defineChannelTool,
} from "@copilotkit/channels";
import { z } from "zod";

/** Above this many options, buttons stop fitting a Slack row; use a menu. */
const MAX_BUTTONS = 5;

/** Slack rejects a text object that is empty, so blank cells need a stand-in. */
const EMPTY_CELL = "—";

/**
 * Recover a plain URL from whatever the model passed.
 *
 * Slack delivers links to the agent in its own markup — `<https://x/y|x/y…>`,
 * with the display half often elided — and the model tends to hand back what
 * it saw. Posting that produces `invalid field at /blocks/N/image_url`, which
 * is a *non-retryable delivery failure*: it aborts the whole run, so the user
 * gets silence rather than an error. Hence normalise here, and reject anything
 * still not a plain https URL.
 */
function normalizeImageUrl(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const pipe = value.indexOf("|");
  if (pipe !== -1) value = value.slice(0, pipe);
  value = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // Slack fetches the image server-side over TLS and will not follow http.
  if (parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * Identify ourselves when probing. Wikimedia — and other large hosts — answer
 * an unidentified client with 400 or 403, which made the probe below reject
 * URLs that Slack itself fetches without trouble.
 */
const PROBE_HEADERS = {
  "user-agent":
    "antigravity-slack-demo/1.0 (+https://github.com/CopilotKit/antigravity-slack-demo)",
  accept: "image/*,*/*;q=0.8",
};

/** Some hosts reject HEAD outright; ask for a single byte instead. */
async function probe(url: string, method: "HEAD" | "GET"): Promise<Response> {
  return fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(5_000),
    headers:
      method === "GET"
        ? { ...PROBE_HEADERS, range: "bytes=0-0" }
        : PROBE_HEADERS,
  });
}

/**
 * Check the URL looks fetchable, and say why not in terms the model can act on.
 *
 * Deliberately biased towards posting. A malformed URL is fatal — Slack
 * rejects the block and aborts the run — but that case is already handled by
 * {@link normalizeImageUrl}; a well-formed URL that merely 500s costs at worst
 * a broken thumbnail. So only a definite "this is not an image" refuses:
 * anything ambiguous (405, 403, a host that dislikes probes) is allowed
 * through rather than risking a false rejection, which is what sent an earlier
 * run off mirroring the file to a third-party host.
 */
async function imageFetchProblem(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await probe(url, "HEAD");
    // Method-not-allowed and friends say nothing about the image itself.
    if (response.status >= 400) response = await probe(url, "GET");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Could not reach ${url} (${reason}). Slack fetches images server-side, so the link must be publicly reachable. Nothing was posted - do not try to mirror or re-upload the file, just use a different URL or tell the user.`;
  }

  if (response.status === 404 || response.status === 410) {
    return `${url} returned HTTP ${response.status} - there is nothing there. Nothing was posted; use a different URL or tell the user.`;
  }

  const contentType = response.headers.get("content-type") ?? "";
  // A 200 serving HTML is the usual shape of a link to a *page about* an image
  // rather than the image file itself.
  if (response.ok && contentType && !contentType.startsWith("image/")) {
    return `${url} serves "${contentType}", not an image. Link directly to the image file. Nothing was posted.`;
  }
  return null;
}

/**
 * Show an image.
 *
 * A tool rather than a component so a bad URL can be *reported to the model*
 * instead of reaching Slack: the return value of a tool is what the model
 * reads, so it can correct itself and retry, which a component's renderer has
 * no way to do.
 */
export const ShowImage = defineChannelTool({
  name: "show_image",
  description:
    "Display an image to the user. Use this whenever the answer is better " +
    "shown than described - a diagram, screenshot, photo or chart image. " +
    "Pass a bare public https URL pointing at the image file itself, with no " +
    "surrounding <> or | markup. Slack fetches it server-side, so localhost " +
    "paths, file paths and anything needing a login will not work.",
  parameters: z.object({
    url: z.string().describe("Bare public https URL of the image file."),
    alt: z
      .string()
      .optional()
      .describe("Short description for screen readers."),
    caption: z
      .string()
      .optional()
      .describe("One line shown above the image explaining what it is."),
  }),
  async handler({ url, alt, caption }, { thread }) {
    const normalized = normalizeImageUrl(url);
    if (!normalized) {
      return (
        `"${url}" is not a usable image URL, so nothing was posted. It must be ` +
        "a plain https:// link to the image file - strip any <> or | markup " +
        "Slack added around it."
      );
    }

    const problem = await imageFetchProblem(normalized);
    if (problem) return problem;

    await thread.post(
      <Message>
        {caption ? (
          <Section>
            <Markdown>{caption}</Markdown>
          </Section>
        ) : null}
        <Image url={normalized} alt={alt ?? caption ?? "image"} />
      </Message>,
    );
    return "Displayed the image to the user. Acknowledge briefly; do not repeat the URL back to them.";
  },
});

/**
 * Show a small table.
 *
 * Included because `<Chart>` is not renderable on Slack (see the file header):
 * this is the honest way to put structured numbers in the thread.
 */
export const ShowTable = defineChannelComponent({
  name: "show_table",
  description:
    "Display rows of structured data as a table. Prefer this over an ASCII " +
    "table in a code block. Keep it small - a handful of columns and at most " +
    "about ten rows read well in Slack.",
  parameters: z.object({
    title: z.string().optional().describe("Optional line above the table."),
    // Non-empty: Slack rejects a text object with an empty string, and an
    // invalid block aborts the whole run rather than degrading.
    columns: z
      .array(z.string().min(1))
      .min(1)
      .max(6)
      .describe("Column headers, each non-empty."),
    rows: z
      .array(z.array(z.string()))
      .min(1)
      .max(20)
      .describe("Rows, each an array of cells matching the columns order."),
  }),
  render({ title, columns, rows }) {
    return (
      <Message>
        {title ? (
          <Section>
            <Markdown>{title}</Markdown>
          </Section>
        ) : null}
        <Table columns={columns.map((header) => ({ header }))}>
          {rows.map((cells) => (
            <Row>
              {/* Short rows are padded so cells stay under their headers, and
                  blank cells get a dash -- see the schema note above. */}
              {columns.map((_, index) => (
                <Cell>{cells[index]?.trim() || EMPTY_CELL}</Cell>
              ))}
            </Row>
          ))}
        </Table>
      </Message>
    );
  },
});

/**
 * Ask the user to pick an option, as clickable controls.
 *
 * A tool rather than a component because it does more than render: the click
 * handlers have to feed the answer back into the agent.
 *
 * **Non-blocking by necessity.** With `awaitChoice` unavailable the handler
 * cannot return the user's pick as the tool result, so it returns a note
 * telling the model to stop and wait. The click then calls `runAgent({ prompt })`,
 * which injects the choice as a user message and starts a fresh turn — the
 * agent reads it as if the user had typed it.
 *
 * Inline handlers are bound by content-stable IDs and route in-process only,
 * so a click after a worker restart is dropped. The user can always type the
 * answer instead, which is why the posted message names the options in text.
 */
export const AskChoice = defineChannelTool({
  name: "ask_choice",
  description:
    "Ask the user to choose between options by clicking, instead of asking " +
    "them to type an answer. Use it for a short decision with a known set of " +
    "answers - which file to open, which approach to take, yes or no. " +
    "This does NOT return the answer: it posts the choices and stops your " +
    "turn. The user's pick arrives as their next message.",
  parameters: z.object({
    question: z.string().describe("The question, one line."),
    options: z
      .array(
        z.object({
          label: z.string().max(75).describe("Text on the control."),
          value: z
            .string()
            .describe(
              "What is sent back as the user's answer when this is picked. " +
                "Make it self-explanatory: it is read without the question.",
            ),
        }),
      )
      .min(2)
      .max(25)
      .describe("Between 2 and 25 options."),
  }),
  async handler({ question, options }, { thread }) {
    // Re-entering the agent is what makes the pick an answer rather than a
    // dead click. Shared by both control types below.
    const answer = async (
      picked: string,
      ctx: { thread: typeof thread },
    ): Promise<void> => {
      const label =
        options.find((option) => option.value === picked)?.label ?? picked;
      // Slack shows nothing when a button is clicked, so without this the
      // thread would jump to the agent replying to an invisible message.
      await ctx.thread.post(
        <Message>
          <Context>{`Chose: ${label}`}</Context>
        </Message>,
      );
      await ctx.thread.runAgent({ prompt: picked });
    };

    await thread.post(
      <Message>
        <Section>
          <Markdown>{question}</Markdown>
        </Section>
        <Actions>
          {options.length <= MAX_BUTTONS ? (
            options.map((option) => (
              <Button
                value={option.value}
                onClick={async (ctx) => {
                  await answer(String(ctx.action.value), ctx);
                }}
              >
                {option.label}
              </Button>
            ))
          ) : (
            <Select
              placeholder="Choose one"
              options={options}
              onSelect={async (ctx) => {
                await answer(String(ctx.action.value), ctx);
              }}
            />
          )}
        </Actions>
        {/* A restart drops the inline handlers; typing still works. */}
        <Context>Or just reply with your answer.</Context>
      </Message>,
    );

    return (
      "Posted the choices to the user and ended your turn. Do not ask the " +
      "question again and do not guess an answer - their pick will arrive as " +
      "their next message."
    );
  },
});

/**
 * Everything registered on the channel, in one place.
 *
 * Components render and nothing more; tools are the ones that need to talk
 * back to the model — to report a bad URL, or to say "I posted a picker, stop
 * and wait".
 */
export const UI_COMPONENTS = [ShowTable];
export const UI_TOOLS = [ShowImage, AskChoice];
