# Other runtimes

Everything else in this guide assumes Claude Code. Codex, Gemini and Antigravity agents work in the same window with a few differences.

## What each runtime can do

| | Claude Code | Codex | Gemini | Antigravity |
|---|:---:|:---:|:---:|:---:|
| Run as an agent | yes | yes | yes | yes |
| Live status in the left column | yes | yes | yes | yes, except "Needs input" |
| Send messages to other agents | yes | yes | yes | yes |
| Receive messages from other agents | yes, automatic | yes, automatic, shown inline | via "Incoming messages": you deliver with a click | via "Incoming messages" |
| Permission modes | all four | Ask, Accept edits, Bypass (no Plan) | all four | Antigravity's own (see below) |
| Usage bar in the bottom right | yes | yes | no | no |
| Come back after a restart with its history | yes | yes | no, starts fresh | yes |

This is the same table the "Create New Agent" form summarises on each runtime card.

## Setting up a runtime

autonomOS looks for the `codex`, `gemini` and `agy` commands when it starts. Install the runtime the way its maker documents, log in to it once in a normal terminal, then reopen the "Create New Agent" form. The runtime card changes from "Not installed" to a selectable card. If it still shows "Not installed", run `autonomos restart`.

autonomOS never asks for API keys for any runtime. It uses the login each program already has.

## Codex

A Codex agent is a real Codex session. Two things look different:

- **Messages arrive inline.** When another agent messages a Codex agent, the text appears in its conversation immediately, even mid-task. Codex handles the timing itself.
- **Its replies reach the bell.** When a Codex agent finishes a turn, its reply also appears in the notifications panel and counts as unread on its row, the way a Claude Code agent's message to you does.
- **The usage bar** ("30d 10%") appears in the bottom bar as soon as a Codex login exists on the machine, and shows nothing when it does not.

Codex has no "Plan" mode; the form shows "Plan (n/a)" and falls back to "Ask".

## Gemini

A Gemini agent is a real Gemini CLI session. The one thing that changes how you work is how messages reach it:

**Messages to a Gemini agent arrive through you.** When another agent sends something to a Gemini agent, it waits in a queue, and you hand it over:

- The Gemini agent's row shows a gold "✉ 1" badge (tooltip: "1 awaiting your delivery").
- Its terminal shows a small floating panel titled "Incoming messages", listing each waiting message with the sender's name.
- Click **"Deliver"** to paste that message into the terminal as if you had typed it. The panel confirms once the agent has taken it; until then it stays in the queue. **"Discard"** drops it.

You can drag the panel out of the way; it remembers where you put it.

Two smaller differences: there is no usage bar for Gemini, and a restarted Gemini agent starts a fresh conversation instead of resuming the old one.

## Antigravity

An Antigravity agent is a real Antigravity CLI (`agy`) session. Google moved personal plans (Google AI Pro, Ultra and the free tier) from Gemini CLI to Antigravity CLI in June 2026, so this is the runtime to pick if you want an agent on one of those plans. Install it with Google's one-line installer from [antigravity.google](https://antigravity.google/docs/getting-started), then run `agy` once in a normal terminal and sign in with your Google account. On a server over SSH it prints a link; open it on your own computer and paste the code back.

- **Messages arrive through you**, exactly as for Gemini: the "✉" badge and the "Incoming messages" panel.
- **Permissions use Antigravity's own words.** `agentMode` is `default` (asks before acting), `accept-edits`, `auto` or `plan`; `toolPermission` is `request-review`, `strict`, `proceed-in-sandbox` or `always-proceed`. An agent starts as `agentMode=default`, even though Antigravity itself starts in `auto` when nothing is set.
- **No "Needs input" status.** Antigravity reports tools and turns, but not when it is waiting for an answer, so look at its terminal if it seems stuck.
- **No paid credits.** When your plan's quota runs out, an autonomOS Antigravity agent waits for it to refresh. It never spends purchased AI credits, whatever your own Antigravity setting says. Type `/usage` in its terminal to see what's left.
- **A restart resumes the conversation.**

autonomOS adds one entry called `autonomos` to Antigravity's `~/.gemini/config/hooks.json` and `mcp_config.json` when it starts. It does nothing in Antigravity sessions you start yourself, and your other entries are left alone.

## Mixing runtimes

A team can mix all four. A Claude Code Dispatcher can spawn a Codex worker and a Gemini reviewer, message both, and read their replies; the org chart shows each with its own logo. The only thing to remember is the Gemini delivery step above: if a Gemini agent seems to be ignoring its manager, check its row for the "✉" badge.
