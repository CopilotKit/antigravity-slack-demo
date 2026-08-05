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

/**
 * Show an image.
 *
 * A component rather than a tool: `defineChannelComponent` gives the SDK a
 * schema it can hand the model *and* a renderer, so posting is handled for us
 * and the handler survives a restart when a durable store is configured.
 */
export const ShowImage = defineChannelComponent({
  name: "show_image",
  description:
    "Display an image to the user. Use this whenever the answer is better " +
    "shown than described - a diagram, screenshot, photo or chart image. " +
    "The URL must be a public https link that needs no authentication; " +
    "Slack fetches it server-side, so localhost and file paths will not work.",
  parameters: z.object({
    url: z.string().describe("Public https URL of the image."),
    alt: z
      .string()
      .optional()
      .describe("Short description for screen readers."),
    caption: z
      .string()
      .optional()
      .describe("One line shown above the image explaining what it is."),
  }),
  render({ url, alt, caption }) {
    return (
      <Message>
        {caption ? (
          <Section>
            <Markdown>{caption}</Markdown>
          </Section>
        ) : null}
        <Image url={url} alt={alt ?? caption ?? "image"} />
      </Message>
    );
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
    columns: z.array(z.string()).min(1).max(6).describe("Column headers."),
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
              {/* Short rows are padded so cells stay under their headers. */}
              {columns.map((_, index) => (
                <Cell>{cells[index] ?? ""}</Cell>
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

/** Everything registered on the channel, in one place. */
export const UI_COMPONENTS = [ShowImage, ShowTable];
export const UI_TOOLS = [AskChoice];
