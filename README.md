# antigravity-slack-demo

The Antigravity agent, in Slack.

Public on purpose: it holds no credentials, and a public repository URL is all
Render needs to deploy it — no GitHub App install required. Secrets are set in
the Render dashboard, never here.

```
Slack  →  CopilotKit Intelligence  →  channel worker  →  agent  →  back
```

Two services, neither with public ingress. Slack's events go to CopilotKit, and
the worker dials *out* to the realtime gateway — nothing inbound, no TLS to
manage.

| Service | Render type | Why |
|---|---|---|
| `agent` | Private Service + 1 GB disk | Python. Runs Antigravity, which drives a Go `localharness` subprocess doing real file and shell work. Only the worker can reach it. |
| `channel` | Background Worker | Node. Holds the outbound gateway socket and maps Slack threads onto agent sessions. |

## Deploy

1. **New → Blueprint** in Render, point it at this repo. `render.yaml` defines both services.
2. Set the two secrets (both marked `sync: false`, so Render prompts):
   - `GEMINI_API_KEY` on `antigravity-agent`
   - `COPILOTKIT_API_KEY` on `antigravity-channel` (the `cpk-…` project runtime key)
3. The Slack app itself is configured out-of-band with
   `npx copilotkit channels add --name antigravity --adapter slack --json`.
   Those credentials live server-side at CopilotKit, not here.

Region is `oregon`. Both services must be on a paid plan — free instances spin
down, which drops the gateway socket and any parked session.

## Configuration

Everything below is an env var on the `agent` service, so the capability level
changes from the dashboard without a code change.

| Var | Default | Notes |
|---|---|---|
| `AGENT_TOOLS` | `full` | `chat`, `readonly`, or `full`. `full` adds `create_file`, `edit_file`, `run_command`. |
| `AGENT_TOOL_APPROVAL` | `false` | Off: tools run unattended. With `full` that is **unguarded shell for anyone who can mention the bot**. |
| `AGENT_MODEL` | `gemini-3.6-flash` | Native Gemini path; no OpenAI shim in the image. |
| `AGENT_WORKSPACE` | `/data/ws` | On the disk. Deliberately short — see below. |
| `AGENT_SAVE_DIR` | `/data/save` | Conversation trajectories. On the disk so threads survive a deploy. |
| `AGENT_INSTRUCTIONS` | see `agent/app.py` | System prompt. |

### Why the workspace path is short

A model asked to echo a long, high-entropy path into a tool call gets it wrong
often enough to fail runs, and the harness treats the resulting bad path as
fatal — measured at 0/14 failures on a 9-character path against 2/14 on a
75-character one. `/data/ws` keeps it well clear.

### Why the disk matters

`save_dir` on the disk is what lets a thread resume after the session is swept
or the service restarts. Without it, every deploy gives every thread amnesia.
The disk also pins the service to a single instance — which is correct here,
since sessions live in memory and a parked coroutine cannot be moved.

## The lunch round

The bot's actual job: help the office decide where to order from, collect
everyone's picks into one round, and gate the order behind a human click.

It is split across the two tool surfaces, which is the point of the demo:

| | Where | What it owns |
|---|---|---|
| `search_restaurants`, `get_menu`, `get_order_history` | `agent/lunch.py` — **backend tools on Antigravity** | The catalogue. Plain Python functions; the adapter derives each schema from the signature. |
| `show_restaurants`, `show_menu`, `show_round`, `confirm_order` | `channel/src/lunch-ui.tsx` — **channel tools** | Cards, clicks, round state, the order gate. |

The model is the wire between them: it calls a backend tool, gets JSON, and
passes that JSON to a render tool. That is why the schemas restate the shape
instead of sharing a type — the two halves are different processes in
different languages.

A typical round:

1. *"where should we order from?"* → `search_restaurants` → `show_restaurants`
   posts four cards, and the agent adds a recommendation of its own, informed
   by `get_order_history`.
2. *"let's do thai"* → `get_menu` → `show_menu` posts dish cards and opens the
   round. Picking is conversational; the Choose buttons are just a shortcut.
3. People click **Add**. This is deliberately *not* an agent round trip — the
   click writes thread state and acknowledges directly, so five people
   ordering is five instant writes rather than five model turns.
4. *"what's the round?"* → `show_round` renders who ordered what and the total.
5. *"place it"* → `confirm_order` posts a summary with **Place order** /
   **Cancel** and ends the turn. The agent cannot place anything itself.

Round state lives in Slack thread state (`thread.setState`), so a round is
scoped to a thread, survives a restart, and needs no database.

### The catalogue is invented

There is no self-serve API anywhere that lets a third party browse restaurant
menus and order on a customer's behalf. Marketplace APIs are merchant-facing
and partner-gated; the one sanctioned route to consumer ordering is DoorDash's
[`dd-cli`](https://github.com/doordash-oss/doordash-cli), a waitlisted
**macOS-arm64** binary meant to be driven over a shell by an agent — which
also means it cannot run in this Linux container.

So the restaurants are fictional, on purpose: putting a real business's name on
orders it never agreed to serve is a misrepresentation, not a demo. Swapping in
something real means replacing the three functions in `agent/lunch.py` and
nothing else.

Nothing spends money. The confirm gate still exists, because that is the seam a
real backend attaches to, and by then the difference between proposing an order
and buying lunch for nine people has to be a human click. The confirm handler
re-reads state rather than trusting the click, so two people racing the button
cannot double-order.

### Interactive nodes need JSX keys

A component registered through `defineChannelComponent` is bound with
`requireKeys: true`, so the action registry **throws** on any node with an
event handler that lacks a non-empty, unique JSX key. That throw happens inside
the run loop, so the symptom is silence: nothing posted, nothing logged, and
the model quietly re-issuing the call. It cost a debugging round here.

Keys are how a registered component's handlers survive a restart — bound by key
rather than tree position. `npm run check` type-checks and then walks every
component we ship for unkeyed interactive nodes.

## Rich UI

The agent can post images, tables and clickable choices itself. It speaks plain
AG-UI and knows nothing about Slack, so each of these is registered on the
channel as a **tool** (`channel/src/ui-tools.tsx`): the SDK turns every entry in
`components`/`tools` into a tool descriptor sent on each run, the Antigravity
adapter exposes it to the model as a client-side tool, and the call parks until
this side renders it and answers.

| Tool | Renders | Notes |
|---|---|---|
| `show_image` | Uploaded file | Downloads the URL and uploads the bytes — see below. |
| `show_table` | Block Kit table | Up to 6 columns, 20 rows. |
| `ask_choice` | Buttons, or a menu above 5 options | Does not return the pick — see below. |

Nothing in the system prompt mentions them; the tool descriptions are what
teach the model when to reach for one.

### Why `show_image` uploads rather than linking

An `<Image url>` block makes **Slack** fetch the URL when the message is
posted. If that fetch fails, Slack answers `invalid_blocks`, which is a
non-retryable delivery failure: it aborts the whole run, so the user gets
silence instead of an error. It is not predictable from the worker either —
during testing a Wikimedia thumbnail that the worker downloaded without trouble
was refused by Slack's own fetcher.

So the tool downloads the bytes itself and posts them with `thread.postFile`.
Slack never fetches anything, and every remaining failure — unreachable,
non-2xx, not an image, empty, over 8 MB — is one the worker can see and hand
back to the model as text, which it can then act on. Surfaces without file
upload fall back to the URL block.

This matters more than it sounds: the model *does* act on those messages. When
an early version wrongly rejected a good URL, the agent shelled out, downloaded
the file and mirrored it to a public third-party host to get a link that would
pass. The error text now tells it explicitly not to.

### Two more limits worth knowing

**`ask_choice` cannot wait for the click.** `Thread.awaitChoice()` rejects on
managed Channels — `channels-intelligence` declares
`supportsBlockingChoice: false` — so the handler posts the controls and returns
a note telling the model to stop. Clicking calls `runAgent({ prompt })`, which
injects the choice as a user message and starts a fresh turn. The practical
effect is that a pick reads as if the user typed it. Inline click handlers route
in-process only and are dropped after a restart, which is why the posted message
also invites a typed answer.

**No charts.** The Slack Block Kit renderer has cases for image, table, actions,
button, select and input, but none for `chart`, and the renderer is total — a
`<Chart>` is skipped silently, which would look like the agent ignoring the
request. `show_table` covers structured numbers instead.

## Human-in-the-loop

**Currently off.** `AGENT_TOOL_APPROVAL=false` with `AGENT_TOOLS=full` means
write and shell tools run unattended: anyone who can mention the bot can run
commands in `/data/ws`. The Slack channel's membership is the access boundary,
so keep it restricted and treat the instance as disposable.
`AGENT_TOOLS=readonly` disarms it from the dashboard.

The gate exists but is not wired end to end yet. `channel/src/index.tsx`
already registers `onInterrupt` handlers for `tool_approval` and
`ask_question`, and the agent already accepts the answer back via
`forwardedProps.command`. The missing half is the emit side: the Slack renderer
only raises an interrupt for an AG-UI **CUSTOM event whose `name` matches a
registered handler**

```js
if (!e.name || !interruptEventNames.has(e.name)) return;
pendingInterrupt = { eventName: e.name, value };
```

and the agent emits a `RunFinishedInterruptOutcome` instead. Until it also
emits those CUSTOM events, turning `AGENT_TOOL_APPROVAL` on would park every
tool call forever rather than prompting — which reads as a bot that has gone
quiet, not as an error.

## Local development

```bash
# agent
cd agent && pip install -r requirements.txt
GEMINI_API_KEY=… AGENT_WORKSPACE=/tmp/ws AGENT_SAVE_DIR=/tmp/save \
  uvicorn app:app --port 8027

# channel
cd channel && npm install
COPILOTKIT_API_KEY=… npm start
```

## The unreleased dependency

`agent/requirements.txt` installs the integration straight from the ag-ui repo
branch, because it is not on PyPI yet:

```
ag-ui-antigravity @ git+https://github.com/ag-ui-protocol/ag-ui@mme/antigravity#subdirectory=integrations/antigravity/python
```

Pin it to a commit SHA for reproducible deploys, and swap to a released version
once the PR merges. `google-antigravity` ships platform-specific wheels
bundling the Go binary, so it must be installed on the target platform — which
is why the image builds it rather than copying one in.
