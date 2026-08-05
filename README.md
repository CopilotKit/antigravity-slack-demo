# internal-antigravity-slack-channel

The Antigravity agent, in Slack.

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
| `AGENT_TOOLS` | `full` | `chat`, `readonly`, or `full`. `full` adds `create_file`, `edit_file`, `run_command` **behind an approval prompt in Slack**. |
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

## Human-in-the-loop

With `AGENT_TOOLS=full`, a write or shell call posts an Approve/Deny prompt in
the thread and waits.

The wiring is exact and easy to break: the Slack renderer only raises an
interrupt for an AG-UI **CUSTOM event whose `name` matches a registered
handler**, and the answer travels back to the agent as
`forwardedProps.command`. `channel/src/index.tsx` registers `tool_approval` and
`ask_question`; the agent must emit CUSTOM events under exactly those names.

If they do not match, nothing errors — the tool simply stays parked and the bot
looks like it has gone quiet. Set `AGENT_TOOLS=readonly` to take that path out
of play.

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
