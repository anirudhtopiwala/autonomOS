/**
 * Antigravity CLI provider (`agy`) — Google's successor to Gemini CLI for
 * personal accounts. Gemini CLI stopped serving Google AI Pro, Ultra and
 * free-tier personal accounts on 2026-06-18; Antigravity CLI is where those
 * plans run now. See ADR-162. Everything below was measured on agy 1.5.14.
 *
 * Key differences from Gemini CLI:
 * - Hooks + MCP can't be pointed at a per-process file: agy reads them from
 *   `~/.gemini/config/{hooks.json,mcp_config.json}` (or a workspace's
 *   `.agents/`), and ignores hooks in `--settings`. So autonomOS owns ONE named
 *   entry (`autonomos`) in each global file, merged in at boot and inert outside
 *   an autonomOS spawn (every command is gated on AUTONOMOS_SESSION_ID).
 * - System prompt: injected by the SessionStart hook's reply (`injectSteps`),
 *   not prepended to the user's prompt.
 * - Conversation id: agy assigns it; every hook event carries it as
 *   `conversationId`. It's persisted as providerThreadId (the Codex field) and
 *   resumed with `--conversation <id>`. An UNKNOWN id silently starts a new
 *   conversation, so the pre-flight checks the conversation file first.
 * - Permissions + trust go through `--settings` (session-only, never saved):
 *   it rejects an unknown value at startup, where `--mode` silently ignores one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProvider, ResolvedSpawnOptions } from "@autonomos/core";
import { getConfigDir } from "../configDir.js";
import { getControlSocketPath } from "../internalSocket.js";
import { getServerPort } from "../serverState.js";
import { getSettings } from "../settings.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  effectivePermission,
  HOOK_CMD,
  resolveBinaryFromCandidates,
} from "./shared.js";

/** Name of the entry autonomOS owns in agy's global hooks.json / mcp_config.json. */
export const AGY_ENTRY = "autonomos";

/**
 * agy-native hook event → CC-style event name. PreInvocation fires before
 * EVERY model call of a turn; only the first (`invocationNum` 0) means "a turn
 * started", so normalizeEvent maps that one to UserPromptSubmit and drops the
 * rest. PostInvocation has no status meaning of its own (Stop follows).
 */
const AGY_TO_CC_EVENT: Record<string, string> = {
  SessionStart: "SessionStart",
  PreInvocation: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  Stop: "Stop",
};

/** Registered but deliberately dropped (see AGY_TO_CC_EVENT). */
const INTENTIONAL_DROPS = new Set(["PostInvocation"]);

/** Every event the global hooks entry registers. */
export const AGY_HOOK_EVENTS = [
  ...Object.keys(AGY_TO_CC_EVENT),
  ...INTENTIONAL_DROPS,
];

/** agy only accepts `matcher` on the tool events; "*" matches every tool. */
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/**
 * SessionStart's command KEEPS curl's stdout: agy reads the hook's reply as
 * JSON, and the route answers with `injectSteps` carrying this agent's system
 * prompt. Outside an autonomOS spawn (no session id), or if the relay is down,
 * it prints `{}` — inject nothing, never block. Exit 0 always (as HOOK_CMD).
 */
export const AGY_SESSION_START_CMD =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  '[ -n "${AUTONOMOS_SESSION_ID}" ] || { echo "{}"; exit 0; }; ' +
  'curl -sf --max-time 2 -X POST -H "Content-Type: application/json"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -H "X-Agent-Token: ${AUTONOMOS_AGENT_TOKEN}"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' --unix-socket "${AUTONOMOS_INTERNAL_SOCKET}"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -d @- "http://localhost/api/hooks/${AUTONOMOS_SESSION_ID}"' +
  ' 2>/dev/null || echo "{}"';

/** Every other event: the shared relay, skipped outright outside autonomOS. */
export const AGY_HOOK_CMD = `[ -n "\${AUTONOMOS_SESSION_ID}" ] || exit 0; ${HOOK_CMD}`;

/**
 * The system prompt each live session should receive at SessionStart, keyed by
 * autonomOS session id. Filled at buildArgs (every spawn and respawn), read by
 * hookReply. In memory on purpose: a server restart respawns every agent,
 * which runs buildArgs again before agy can fire SessionStart.
 */
const pendingSystemPrompts = new Map<string, string>();

const binaryCache = { path: null as string | null };

/** agy's data dir for a given env (its conversations live under it). */
export function agyDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.HOME || homedir(), ".gemini", "antigravity-cli");
}

/** agy's shared config dir (global hooks.json / mcp_config.json). */
export function agyConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.HOME || homedir(), ".gemini", "config");
}

/**
 * The per-spawn `--settings` object (session-only; agy never writes it back).
 * - agentMode / toolPermission: the agent's permission. agy's "default" mode
 *   is the settings value "" — and it must be explicit, because with nothing
 *   set a personal account starts in `auto`.
 * - useG1Credits: false — an autonomOS agent never spends paid AI credits once
 *   the plan's quota runs out; it waits for the quota to refresh, whatever the
 *   operator's own agy setting says.
 * - trustedWorkspaces: with Auto-Trust on, the agent's cwd, so agy's "Do you
 *   trust the contents of this project?" dialog never renders.
 */
export function buildAgySettings(
  options: ResolvedSpawnOptions,
  autoTrust: boolean,
): Record<string, unknown> {
  const p = effectivePermission("antigravity", options).values;
  const settings: Record<string, unknown> = {
    agentMode: p.agentMode === "default" ? "" : p.agentMode,
    toolPermission: p.toolPermission,
    useG1Credits: false,
  };
  if (autoTrust) settings.trustedWorkspaces = [options.cwd];
  return settings;
}

export const antigravityProvider: AgentProvider = {
  name: "antigravity",
  displayName: "Antigravity CLI",

  capabilities: {
    // Registered once in agy's global hooks.json (not per spawn), but needs no
    // operator step: the server merges its entry in at boot.
    hooks: {
      eventCount: AGY_HOOK_EVENTS.length,
      perSession: false,
      requiresSetup: false,
    },
    liveStatus: { supported: true, method: "hooks" },
    mcp: { supported: true, perSession: false },
    systemPrompt: { supported: true, method: "session-start-hook" },
    // Like Gemini: no live inbound path into the interactive TUI, so the
    // gateway queues messages for hand-delivery (handoffQueue.ts).
    messaging: {
      outbound: true,
      inbound: false,
      inboundMethod: "manual-queue",
    },
    presetSessionId: false,
    sessionResume: true,
    sessionFork: false,
    agentNaming: false,
  },

  startupNotices: [
    {
      // agy 1.5.14's trust dialog, verbatim from a real render.
      needle: "Do you trust the contents of this project?",
      message:
        "Antigravity is asking whether to trust this folder. Answer in its terminal, or turn on Auto-Trust in Settings to skip this.",
    },
    // NOT a "not signed in" notice: agy 1.5.14 prints "You are currently not
    // signed in." on EVERY start, while it loads the saved login ("Signing
    // in..." follows), so that needle would fire on every healthy spawn.
  ],

  resolveBinary(): string {
    return resolveBinaryFromCandidates(
      "agy",
      commonBinaryCandidates("agy"),
      binaryCache,
    );
  },

  // Is the captured conversation saved where `--conversation` will find it?
  // agy keeps one `<id>.db` per conversation; an unknown id would silently
  // start a NEW conversation (measured), so false only when the conversations
  // dir exists and the file positively doesn't; THROW when we can't tell
  // (the runtime then resumes — fails open, per the hook's contract).
  hasResumableThread(
    options: ResolvedSpawnOptions,
    env: Record<string, string | undefined>,
  ): boolean {
    const id = options.providerThreadId;
    if (!id) return false;
    const dir = join(agyDataDir(env), "conversations");
    if (!existsSync(dir)) {
      throw new Error(`agy conversations dir not found: ${dir}`);
    }
    return existsSync(join(dir, `${id}.db`));
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    if (options.providerThreadId) {
      args.push("--conversation", options.providerThreadId);
    }

    args.push(
      "--settings",
      JSON.stringify(
        buildAgySettings(options, getSettings().autoTrust !== false),
      ),
    );

    // Handed to the SessionStart hook's reply (see hookReply).
    pendingSystemPrompts.set(
      options.sessionId,
      buildSystemPrompt(options.systemPrompt, options.appendSystemPrompt),
    );

    // -i runs the prompt, then stays interactive.
    if (options.prompt) args.push("-i", options.prompt);

    return args;
  },

  buildEnv(sessionId: string, agentName: string): Record<string, string> {
    // agy passes the agent's env through to hook commands AND to MCP
    // subprocesses unfiltered (measured, incl. AUTONOMOS_AGENT_TOKEN), so the
    // base env is all the relay and the channel server need.
    return buildBaseEnv(sessionId, agentName);
  },

  normalizeEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
    const nativeName = raw.hookEventName;
    if (typeof nativeName !== "string") {
      console.warn(
        "[antigravity] dropping malformed hook event (no hookEventName field)",
      );
      return null;
    }
    if (nativeName === "PreInvocation" && raw.invocationNum !== 0) return null;

    const mapped = AGY_TO_CC_EVENT[nativeName];
    if (!mapped) {
      if (!INTENTIONAL_DROPS.has(nativeName)) {
        console.warn(
          `[antigravity] dropping unknown hook event: ${nativeName} ` +
            "(possible vocabulary drift — update AGY_TO_CC_EVENT)",
        );
      }
      return null;
    }

    const out: Record<string, unknown> = { ...raw, hook_event_name: mapped };
    const tool = raw.toolCall as { name?: unknown; args?: unknown } | undefined;
    if (tool && typeof tool === "object") {
      if (typeof tool.name === "string") out.tool_name = tool.name;
      if (tool.args !== undefined) out.tool_input = tool.args;
    }
    if (
      mapped === "PostToolUse" &&
      typeof raw.error === "string" &&
      raw.error !== ""
    ) {
      out.hook_event_name = "PostToolUseFailure";
    }
    if (typeof raw.lastUserInput === "string" && mapped === "UserPromptSubmit")
      out.prompt = raw.lastUserInput;
    return out;
  },

  threadIdFromEvent(raw: Record<string, unknown>): string | undefined {
    const id = raw.conversationId;
    return typeof id === "string" && id !== "" ? id : undefined;
  },

  hookReply(
    raw: Record<string, unknown>,
    sessionId: string,
  ): Record<string, unknown> | undefined {
    if (raw.hookEventName !== "SessionStart") return undefined;
    const prompt = pendingSystemPrompts.get(sessionId);
    if (!prompt) return {};
    // Shape measured on 1.5.14: agy added the systemMessage to the
    // conversation and the agent answered from it.
    return {
      injectSteps: [{ systemMessage: { systemMessage: prompt } }],
    };
  },
};

// ── agy's global config: the autonomOS entry ─────────────────

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {}; // agy creates mcp_config.json empty
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The `autonomos` hooks entry: one command per registered event. */
export function agyHooksEntry(): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const event of AGY_HOOK_EVENTS) {
    const handler = {
      type: "command",
      command: event === "SessionStart" ? AGY_SESSION_START_CMD : AGY_HOOK_CMD,
      timeout: 5,
    };
    entry[event] = TOOL_EVENTS.has(event)
      ? [{ matcher: "*", hooks: [handler] }]
      : [handler];
  }
  return entry;
}

/** The `autonomos` MCP server entry (stdio channel server). */
export function agyMcpEntry(
  channelServerScript: string,
): Record<string, unknown> {
  return {
    // Gate in the shell, so a non-autonomOS agy session never starts node
    // (a failing MCP server doesn't break a session, but there's no reason to
    // start one). Session id and agent token arrive through agy's env
    // passthrough; the agent-invariant planes are pinned here.
    command: "sh",
    args: [
      "-c",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
      '[ -n "${AUTONOMOS_SESSION_ID}" ] || exit 0; exec node "$0"',
      channelServerScript,
    ],
    env: {
      AUTONOMOS_SERVER_URL: `ws+unix://${getControlSocketPath()}:/ws/gateway`,
      AUTONOMOS_API_URL: `http://localhost:${getServerPort()}`,
      AUTONOMOS_CONFIG_DIR: getConfigDir(),
    },
  };
}

/**
 * Merge autonomOS's entry into agy's global hooks.json and mcp_config.json,
 * leaving every other entry as it was. MUST run after the public port and the
 * control socket are bound (run.ts), like writeGeminiSettings.
 *
 * A file that isn't a JSON object is left alone (we'd rather run blind than
 * clobber the operator's config) and the error is thrown to the caller, which
 * logs it.
 */
export function writeAntigravityConfig(
  channelServerScript: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!existsSync(channelServerScript)) {
    console.warn(
      `[antigravity] Channel server script not found: ${channelServerScript} — ` +
        "Antigravity agents will not have MCP tools. Run the build step first.",
    );
  }
  const dir = agyConfigDir(env);

  const hooksPath = join(dir, "hooks.json");
  const hooks = readJsonObject(hooksPath);
  hooks[AGY_ENTRY] = agyHooksEntry();
  writeJson(hooksPath, hooks);

  const mcpPath = join(dir, "mcp_config.json");
  const mcp = readJsonObject(mcpPath);
  const servers =
    mcp.mcpServers && typeof mcp.mcpServers === "object"
      ? (mcp.mcpServers as Record<string, unknown>)
      : {};
  servers[AGY_ENTRY] = agyMcpEntry(channelServerScript);
  mcp.mcpServers = servers;
  writeJson(mcpPath, mcp);

  console.log(
    `[antigravity] wrote the ${AGY_ENTRY} entry to ${hooksPath} and ${mcpPath}`,
  );
}

export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

export function _pendingSystemPromptForTesting(
  sessionId: string,
): string | undefined {
  return pendingSystemPrompts.get(sessionId);
}
