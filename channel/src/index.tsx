/**
 * Slack channel for the Antigravity agent.
 *
 *   Slack → CopilotKit Intelligence → this worker → Antigravity agent → back
 *
 * The agent speaks AG-UI over HTTP, so this is wiring: one agent per Slack
 * thread, subscribe on mention, reply on the messages that follow, and gate
 * write/shell tools behind an approval prompt.
 *
 * Managed Intelligence Channel (the `copilotkit channels` CLI), not the
 * open-source `@copilotkit/channels` adapter product — same words, different
 * configuration.
 */

import { createChannel } from "@copilotkit/channels";
import { Actions, Button, Markdown, Message, Section } from "@copilotkit/channels/ui";
import { HttpAgent } from "@ag-ui/client";
import { UI_COMPONENTS, UI_TOOLS } from "./ui-tools.js";
import { LUNCH_COMPONENTS, LUNCH_TOOLS } from "./lunch-ui.js";
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

function required(names: string[], hint: string): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Set ${names.join(" or ")}. ${hint}`);
}

const CHANNEL_NAME = process.env.CHANNEL_NAME?.trim() || "antigravity";

/** Path the agent is mounted at, matching `create_antigravity_app` in app.py. */
const AGENT_PATH = "/slack";

/**
 * Where the agent lives.
 *
 * On Render, `AGENT_HOSTPORT` is resolved from the private service at deploy
 * time — the internal hostname carries a generated suffix and the port is
 * Render's, not the one the Dockerfile exposes, so neither can be hardcoded.
 * `ANTIGRAVITY_URL` overrides everything, and localhost is the dev default.
 */
function resolveAgentUrl(): string {
  const explicit = process.env.ANTIGRAVITY_URL?.trim();
  if (explicit) return explicit;
  const hostport = process.env.AGENT_HOSTPORT?.trim();
  if (hostport) return `http://${hostport}${AGENT_PATH}`;
  return `http://127.0.0.1:8027${AGENT_PATH}`;
}

const AGENT_URL = resolveAgentUrl();

/**
 * One agent per Slack thread.
 *
 * The Slack thread id is passed through as the AG-UI thread id, which keys the
 * Antigravity session, so a Slack thread is exactly one harness conversation.
 * Two threads never share history and this worker holds no agent state.
 */
const channel = createChannel({
  name: CHANNEL_NAME,
  identifyUser: "platform",
  agent: (threadId: string) => new HttpAgent({ url: AGENT_URL, threadId }),
  // Rich UI, exposed to the agent as tools. Both lists become tool descriptors
  // sent on every run, which the Antigravity adapter turns into client-side
  // tools the model can call -- so the agent posts images and pickers itself
  // rather than describing them in text. See ui-tools.tsx.
  components: [...UI_COMPONENTS, ...LUNCH_COMPONENTS],
  tools: [...UI_TOOLS, ...LUNCH_TOOLS],
});

/**
 * Wraps a handler so the run loop is visible in the logs.
 *
 * Without this the worker logs only startup and errors, so a run that posts a
 * reply and then leaves Slack's typing indicator spinning is indistinguishable
 * from one still doing work: both are silence.
 */
/**
 * Runs still going. Held so a shutdown can wait for them.
 *
 * Render starts the replacement worker before killing this one, and both are
 * attached to the gateway during the overlap -- so a message can land here
 * moments before SIGTERM. Exiting immediately abandons that run: the reply is
 * never posted and Slack's status indicator spins forever, which reads as a
 * slow bot rather than a lost message. Four runs went that way before this
 * existed.
 */
const inFlight = new Set<Promise<unknown>>();

/** Render's grace period is ~30s; leave room for stop() and the exit. */
const DRAIN_MS = 20_000;

async function traced(
  label: string,
  // runAgent resolves to a MessageRef, not void; the result is unused here.
  run: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  console.log(`[${label}] runAgent →`);
  const settled = Promise.resolve().then(run);
  inFlight.add(settled);
  try {
    await settled;
    console.log(`[${label}] runAgent ← returned after ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`[${label}] runAgent ✗ after ${Date.now() - started}ms`, error);
    throw error;
  } finally {
    inFlight.delete(settled);
  }
}

/** Give in-flight runs a bounded chance to finish before the process goes. */
async function drain(signal: string): Promise<void> {
  if (inFlight.size === 0) return;
  console.log(`${signal} — waiting for ${inFlight.size} run(s) to finish…`);
  const started = Date.now();
  // allSettled so one failing run does not cut the wait short for the others.
  const finished = Promise.allSettled([...inFlight]);
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, DRAIN_MS).unref();
  });
  await Promise.race([finished, deadline]);
  if (inFlight.size > 0) {
    console.warn(
      `${inFlight.size} run(s) still going after ${Date.now() - started}ms — exiting anyway`,
    );
  } else {
    console.log(`drained in ${Date.now() - started}ms`);
  }
}

channel.onMention(async ({ thread }) => {
  // Subscribe before running: this is what makes onMessage fire for the rest
  // of the thread. Without it the bot answers once and then goes quiet.
  await thread.subscribe();
  await traced("mention", () => thread.runAgent());
});

channel.onMessage(async ({ thread }) => {
  await traced("message", () => thread.runAgent());
});

// ---------------------------------------------------------------------------
// Human-in-the-loop
// ---------------------------------------------------------------------------
//
// The Slack renderer turns an AG-UI CUSTOM event into a pending interrupt only
// when its `name` matches a handler registered here:
//
//     if (!e.name || !interruptEventNames.has(e.name)) return;
//     pendingInterrupt = { eventName: e.name, value };
//
// The run loop then posts the picker and returns "ack-first"; `thread.resume()`
// re-enters the run later, delivering the answer to the agent as
// `forwardedProps.command`.
//
// So these names must match the CUSTOM events the agent emits exactly.

channel.onInterrupt<{ tool?: string; args?: unknown }>(
  "tool_approval",
  async ({ payload, thread }) => {
    const tool = payload?.tool ?? "a tool";
    const args = JSON.stringify(payload?.args ?? {}, null, 2);
    await thread.post(
      <Message>
        <Section>
          <Markdown>{`*Approve \`${tool}\`?*`}</Markdown>
        </Section>
        <Section>
          <Markdown>{"```\n" + args + "\n```"}</Markdown>
        </Section>
        <Actions>
          <Button
            value={{ approved: true }}
            onClick={async (ctx) => {
              // resume() re-enters the parked run; the value reaches the agent
              // as forwardedProps.command.
              await ctx.thread.resume(ctx.action.value);
            }}
          >
            Approve
          </Button>
          <Button
            value={{ approved: false }}
            onClick={async (ctx) => {
              await ctx.thread.resume(ctx.action.value);
            }}
          >
            Deny
          </Button>
        </Actions>
      </Message>,
    );
  },
);

channel.onInterrupt<{ question?: string }>(
  "ask_question",
  async ({ payload, thread }) => {
    // A free-text answer arrives as the next message in the thread and is
    // picked up by onMessage, so there is nothing to resume explicitly.
    await thread.post(
      <Message>
        <Section>
          <Markdown>{payload?.question ?? "The agent has a question."}</Markdown>
        </Section>
      </Message>,
    );
  },
);

async function main(): Promise<void> {
  // Resolved inside main() so a missing value reaches the catch below as an
  // instruction rather than escaping as a raw stack trace.
  const apiKey = required(
    ["INTELLIGENCE_API_KEY", "COPILOTKIT_API_KEY"],
    "Create a project runtime key (cpk-…) and set it in the service environment.",
  );

  // apiUrl/wsUrl default to CopilotKit's managed platform; override both
  // together and only for a self-hosted deployment.
  const intelligence = new CopilotKitIntelligence({
    apiKey,
    ...(process.env.COPILOTKIT_API_URL
      ? { apiUrl: process.env.COPILOTKIT_API_URL.trim() }
      : {}),
    ...(process.env.COPILOTKIT_INTELLIGENCE_WS_URL
      ? { wsUrl: process.env.COPILOTKIT_INTELLIGENCE_WS_URL.trim() }
      : {}),
  });

  // Channels-only runtime: no web surface, hence no identifyUser. Declaring
  // the Channel here supplies the gateway launcher with canonical run
  // execution and thread history.
  const runtime = new CopilotRuntime({
    intelligence,
    agents: { [CHANNEL_NAME]: new HttpAgent({ url: AGENT_URL }) },
    channels: [channel],
  });

  const handler = createCopilotRuntimeHandler({ runtime });

  console.log(`channel : ${CHANNEL_NAME}`);
  console.log(`agent   : ${AGENT_URL}`);
  console.log("activating…");

  // Bounded on purpose: a wrong or missing realtime websocket URL does not
  // error, it hangs, so an unbounded wait would read as a slow start.
  await handler.channels.ready({ timeoutMs: 60_000 });

  const { overall, channels } = handler.channels.status();
  console.log(`status  : ${overall}`);
  for (const [name, state] of Object.entries(channels)) {
    console.log(`          ${name}: ${state}`);
  }

  if (overall === "setup_required") {
    console.log(
      `\nChannel "${CHANNEL_NAME}" is declared but not attached to Slack. ` +
        "Run `copilotkit channels add` and follow the next action it prints.",
    );
    return;
  }

  console.log("\nlive — mention the bot in Slack");

  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`\n${signal} — stopping…`);
      // Drain before stop(), not after: stop() tears down the transport the
      // in-flight run is posting over. The cost is a small window where this
      // worker can still pick up a message it may not finish -- preferable to
      // reliably abandoning the one already running.
      void drain(signal)
        .catch((error) => console.error("Error draining runs:", error))
        .then(() => handler.channels.stop())
        .catch((error) => console.error("Error stopping channels:", error))
        .finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed to start the channel: ${message}\n`);
  process.exit(1);
});
