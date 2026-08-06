"""The Antigravity agent behind the Slack channel.

Serves one configured agent over AG-UI. Nothing public reaches this: on Render
it is a Private Service, and the only caller is the channel worker on the
internal network.

The examples in the integration repo expose four demo agents; this exposes one,
with the tool set and the approval gate driven by environment variables so the
capability level can be changed from the Render dashboard without a code
change.
"""

from __future__ import annotations

import logging
import os

from ag_ui_antigravity import AntigravityAgent, create_antigravity_app
from google.antigravity import CapabilitiesConfig
from google.antigravity.types import BuiltinTools

from lunch import LUNCH_TOOLS

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("antigravity-agent")

# Short on purpose. A long workspace path is echoed back by the model when it
# builds a tool call, and it garbles long high-entropy paths often enough to
# fail runs -- the harness then treats the bad path as fatal. Measured at 0/14
# failures on a 9-character path against 2/14 on a 75-character one.
WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/data/ws")
SAVE_DIR = os.environ.get("AGENT_SAVE_DIR", "/data/save")
MODEL = os.environ.get("AGENT_MODEL", "gemini-3.6-flash")

# `finish` must always be present: the harness uses it to end a turn.
_CHAT = [BuiltinTools.FINISH]
_READ_ONLY = _CHAT + [
    BuiltinTools.LIST_DIR,
    BuiltinTools.VIEW_FILE,
    BuiltinTools.FIND_FILE,
    BuiltinTools.SEARCH_DIR,
]
_FULL = _READ_ONLY + [
    BuiltinTools.CREATE_FILE,
    BuiltinTools.EDIT_FILE,
    BuiltinTools.RUN_COMMAND,
]
_LEVELS = {"chat": _CHAT, "readonly": _READ_ONLY, "full": _FULL}

# Defaults to `chat`: the lunch bot's capability comes from the Python tools
# below, not from the harness's builtins, and a bot that only needs to talk
# about lunch has no business holding a shell. An earlier version of this
# service ran with `full` and, when a tool returned an error, the model
# resolved it by shelling out and mirroring a file to a public paste host --
# nobody asked it to. Set AGENT_TOOLS=full from the dashboard if you want the
# filesystem demo back.
TOOLS = os.environ.get("AGENT_TOOLS", "chat").strip().lower()
if TOOLS not in _LEVELS:
    raise ValueError(
        f"AGENT_TOOLS must be one of {sorted(_LEVELS)}, got {TOOLS!r}"
    )

# Independent of the tool level, and OFF by default.
#
# On, every non-auto-approved call parks until someone answers in Slack, which
# needs the channel to wire an onInterrupt handler and call thread.resume().
# Off, tools run unattended -- with AGENT_TOOLS=full that means anyone who can
# mention the bot can run shell commands in the workspace, so keep the Slack
# channel restricted and treat the instance as disposable.
#
# When this is off the adapter supplies policy.allow_all() itself, which is
# what satisfies the SDK's mandatory-safety guard for write tools.
APPROVAL = os.environ.get("AGENT_TOOL_APPROVAL", "false").strip().lower() in (
    "1",
    "true",
    "yes",
)

INSTRUCTIONS = os.environ.get(
    "AGENT_INSTRUCTIONS",
    "You are the office lunch bot in Slack. You help a team decide where to "
    "order from and collect everyone's order into one round.\n"
    "- Keep it short. Slack is a chat window, not a document.\n"
    "- Have an opinion. When you show restaurants, say which you would pick "
    "and why -- speed, who ate what yesterday, whether there are veg options. "
    "Do not just list them.\n"
    "- Picking is a conversation, not a form. Act on 'the thai place' or "
    "'something fast' without making anyone click a button.\n"
    "- Show, do not transcribe: after a card or table is posted, summarise in "
    "one line rather than repeating its contents as text.\n"
    "- People add their own items by clicking Add. Never add items for them "
    "and never invent what someone ordered.\n"
    "- Never say an order is placed unless a tool told you it was. Placing "
    "always needs a human click.",
)

os.makedirs(WORKSPACE, exist_ok=True)
os.makedirs(SAVE_DIR, exist_ok=True)

agent = AntigravityAgent(
    model=MODEL,
    api_key=os.environ.get("GEMINI_API_KEY"),
    system_instructions=INSTRUCTIONS,
    capabilities=CapabilitiesConfig(
        enabled_tools=_LEVELS[TOOLS], enable_subagents=False
    ),
    # The lunch catalogue. Plain Python functions -- the adapter derives each
    # schema from the signature and reports the result back as a tool call, so
    # the model sees them exactly like any built-in.
    tools=LUNCH_TOOLS,
    workspaces=[WORKSPACE],
    # On the Render disk, so a restart or deploy does not lose conversation
    # history: a returning thread resumes from here.
    save_dir=SAVE_DIR,
    tool_approval=APPROVAL,
    enable_ask_question=True,
    max_conversations_per_process=int(
        os.environ.get("AGENT_MAX_CONVERSATIONS_PER_PROCESS", "8")
    ),
)

logger.info(
    "tools=%s approval=%s model=%s workspace=%s save_dir=%s",
    TOOLS,
    APPROVAL,
    MODEL,
    WORKSPACE,
    SAVE_DIR,
)

# Named rather than mounted at "/", so the channel's URL says what it targets.
app = create_antigravity_app({"slack": agent})
