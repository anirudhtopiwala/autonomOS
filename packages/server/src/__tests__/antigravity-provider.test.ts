/**
 * Antigravity CLI (`agy`) provider — ADR-162.
 *
 * The event mapping and the trust notice are checked against REAL agy 1.5.14
 * output: `agy-hook-events.json` is the raw stdin of every hook in one
 * read-only turn, and `agy-trust-dialog.json` the raw PTY bytes of the trust
 * dialog (both with the home path renamed). A mapping or needle that only fits
 * an idealized payload can't pass here.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  completePermission,
  legacyModeFor,
  neverAsks,
  parseRuntimePermission,
  permissionFromLegacyMode,
  type ResolvedSpawnOptions,
} from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-agy-"));

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53926);
setAuthToken("test-token-antigravity-abcdef");
setInternalSocketPath(`/tmp/aos-agy-${randomUUID().slice(0, 8)}.sock`);
const {
  AGY_ENTRY,
  AGY_HOOK_CMD,
  AGY_HOOK_EVENTS,
  AGY_SESSION_START_CMD,
  antigravityProvider: agy,
  buildAgySettings,
  writeAntigravityConfig,
} = await import("../providers/antigravity.js");
const { createStartupNoticeScanner } = await import(
  "../agents/startupNotices.js"
);
const { agyAcceptsOutput, agySettingsValue } = await import(
  "../runtimeProbe.js"
);
const { BASE_CONTEXT } = await import("../providers/shared.js");

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
const HOOK_EVENTS: Record<string, unknown>[] = fixture(
  "agy-hook-events.json",
).events;
const TRUST_DIALOG: string = fixture("agy-trust-dialog.json").output;

function opts(over: Partial<ResolvedSpawnOptions> = {}): ResolvedSpawnOptions {
  return {
    workingDirectory: "/work/repo",
    cwd: "/work/repo",
    sessionId: randomUUID(),
    agentName: "agy-test",
    providerSessionId: randomUUID(),
    injectChannelServer: true,
    channelServerScript: "/opt/autonomos/channel-server.mjs",
    serverPort: "53926",
    socketPath: "/tmp/x.sock",
    apiUrl: "http://localhost:53926",
    ...over,
  };
}

function settingsArg(args: string[]): Record<string, unknown> {
  const i = args.indexOf("--settings");
  assert.ok(i >= 0, "--settings must be passed");
  return JSON.parse(args[i + 1]);
}

describe("agy hook events → CC vocabulary (real 1.5.14 payloads)", () => {
  const mapped = HOOK_EVENTS.map((e) => agy.normalizeEvent?.(e) ?? null);

  it("maps one turn to SessionStart, one turn start, the tool pair, Stop", () => {
    assert.deepEqual(
      mapped.filter((e) => e !== null).map((e) => e?.hook_event_name),
      ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    );
  });

  it("only the FIRST model call of a turn is a turn start", () => {
    const pre = HOOK_EVENTS.map((e, i) => ({ e, out: mapped[i] })).filter(
      ({ e }) => e.hookEventName === "PreInvocation",
    );
    assert.equal(pre.length, 2, "fixture has two model calls in the turn");
    assert.equal(pre[0].out?.hook_event_name, "UserPromptSubmit");
    assert.equal(pre[1].out, null);
  });

  it("drops PostInvocation", () => {
    for (const [i, e] of HOOK_EVENTS.entries())
      if (e.hookEventName === "PostInvocation") assert.equal(mapped[i], null);
  });

  it("lifts toolCall into tool_name / tool_input", () => {
    const pre = mapped.find((e) => e?.hook_event_name === "PreToolUse");
    assert.equal(pre?.tool_name, "read_file");
    assert.ok(pre?.tool_input && typeof pre.tool_input === "object");
  });

  it("a PostToolUse with an error is a PostToolUseFailure", () => {
    const post = HOOK_EVENTS.find((e) => e.hookEventName === "PostToolUse");
    assert.ok(post);
    const failed = agy.normalizeEvent?.({
      ...post,
      error: "permission denied",
    });
    assert.equal(failed?.hook_event_name, "PostToolUseFailure");
  });

  it("drops a malformed or unknown event", () => {
    assert.equal(agy.normalizeEvent?.({}), null);
    assert.equal(agy.normalizeEvent?.({ hookEventName: "SomethingNew" }), null);
  });

  it("every event carries the conversation id threadIdFromEvent reads", () => {
    const ids = new Set(HOOK_EVENTS.map((e) => agy.threadIdFromEvent?.(e)));
    assert.equal(ids.size, 1);
    const [id] = ids;
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    assert.equal(agy.threadIdFromEvent?.({ conversationId: "" }), undefined);
  });

  it("registers exactly the events it maps or deliberately drops", () => {
    const seen = new Set(HOOK_EVENTS.map((e) => e.hookEventName));
    assert.deepEqual([...AGY_HOOK_EVENTS].sort(), [...seen].sort());
    assert.equal(agy.capabilities.hooks.eventCount, AGY_HOOK_EVENTS.length);
  });
});

describe("agy spawn argv", () => {
  it("pins agy's default mode explicitly (a personal account defaults to auto)", () => {
    const s = settingsArg(agy.buildArgs(opts()));
    assert.equal(s.agentMode, "");
    assert.equal(s.toolPermission, "request-review");
  });

  it("never lets an autonomOS agent spend paid AI credits", () => {
    assert.equal(settingsArg(agy.buildArgs(opts())).useG1Credits, false);
  });

  it("maps each permission to its settings value", () => {
    const p = completePermission("antigravity", {
      agentMode: "plan",
      toolPermission: "strict",
    });
    const s = buildAgySettings(opts({ permission: p }), false);
    assert.equal(s.agentMode, "plan");
    assert.equal(s.toolPermission, "strict");
  });

  it("Auto-Trust trusts only the agent's cwd, and only when on", () => {
    assert.deepEqual(buildAgySettings(opts(), true).trustedWorkspaces, [
      "/work/repo",
    ]);
    assert.equal(buildAgySettings(opts(), false).trustedWorkspaces, undefined);
  });

  it("resumes a captured conversation and passes a prompt with -i", () => {
    const args = agy.buildArgs(
      opts({ providerThreadId: "conv-1", prompt: "do the thing" }),
    );
    assert.deepEqual(args.slice(0, 2), ["--conversation", "conv-1"]);
    assert.deepEqual(args.slice(-2), ["-i", "do the thing"]);
    assert.ok(!agy.buildArgs(opts()).includes("--conversation"));
  });

  it("never passes the dangerous flag or --mode (it ignores bad values)", () => {
    const bypass = permissionFromLegacyMode("antigravity", "bypass");
    const args = agy.buildArgs(opts({ permission: bypass }));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.ok(!args.includes("--mode"));
    assert.equal(settingsArg(args).toolPermission, "always-proceed");
  });
});

describe("system prompt via the SessionStart reply", () => {
  const sessionStart = HOOK_EVENTS.find(
    (e) => e.hookEventName === "SessionStart",
  ) as Record<string, unknown>;

  it("answers SessionStart with injectSteps carrying the agent's prompt", () => {
    const o = opts({ appendSystemPrompt: "You review PRs." });
    agy.buildArgs(o);
    const reply = agy.hookReply?.(sessionStart, o.sessionId) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    const text = reply.injectSteps[0].systemMessage.systemMessage;
    assert.ok(text.startsWith(BASE_CONTEXT));
    assert.match(text, /You review PRs\.$/);
  });

  it("injects nothing for a session it never built, and only at SessionStart", () => {
    assert.deepEqual(agy.hookReply?.(sessionStart, randomUUID()), {});
    const o = opts();
    agy.buildArgs(o);
    assert.equal(
      agy.hookReply?.({ hookEventName: "Stop" }, o.sessionId),
      undefined,
    );
  });
});

describe("agy conversation pre-flight", () => {
  const home = mkdtempSync(join(tmpdir(), "aos-agy-home-"));
  const env = { HOME: home };
  const convDir = join(home, ".gemini", "antigravity-cli", "conversations");

  it("can't tell before agy ever ran → throws (the runtime fails open)", () => {
    assert.throws(() =>
      agy.hasResumableThread?.(opts({ providerThreadId: "abc" }), env),
    );
  });

  it("true when the conversation is saved, false when positively absent", () => {
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "abc.db"), "");
    assert.equal(
      agy.hasResumableThread?.(opts({ providerThreadId: "abc" }), env),
      true,
    );
    assert.equal(
      agy.hasResumableThread?.(opts({ providerThreadId: "gone" }), env),
      false,
    );
  });
});

describe("agy startup notices (real render)", () => {
  const scan = (chunks: string[]) => {
    const fired: string[] = [];
    const feed = createStartupNoticeScanner(agy.startupNotices ?? [], (m) =>
      fired.push(m),
    );
    for (const c of chunks) feed(c);
    return fired;
  };

  it("fires once on the real trust dialog, however it's chunked", () => {
    for (const size of [1, 7, 64, TRUST_DIALOG.length]) {
      const chunks: string[] = [];
      for (let i = 0; i < TRUST_DIALOG.length; i += size)
        chunks.push(TRUST_DIALOG.slice(i, i + size));
      assert.equal(scan(chunks).length, 1, `chunk size ${size}`);
    }
  });

  it("does NOT treat the every-start 'not signed in' banner as a problem", () => {
    // The real render prints it while loading a saved login.
    assert.match(TRUST_DIALOG, /You are currently not signed in\./);
    assert.ok(
      !(agy.startupNotices ?? []).some((n) => /signed in/.test(n.needle)),
    );
  });
});

describe("agy global config: the autonomos entry", () => {
  const script = "/opt/autonomos/channel-server.mjs";

  it("merges into hooks.json and mcp_config.json, keeping other entries", () => {
    const home = mkdtempSync(join(tmpdir(), "aos-agy-cfg-"));
    const dir = join(home, ".gemini", "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify({ mine: { Stop: [{ type: "command", command: "x" }] } }),
    );
    writeFileSync(join(dir, "mcp_config.json"), ""); // agy creates it empty
    writeAntigravityConfig(script, { HOME: home });
    writeAntigravityConfig(script, { HOME: home }); // idempotent

    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(hooks).sort(), [AGY_ENTRY, "mine"]);
    assert.deepEqual(
      Object.keys(hooks[AGY_ENTRY]).sort(),
      [...AGY_HOOK_EVENTS].sort(),
    );
    assert.equal(hooks[AGY_ENTRY].PreToolUse[0].matcher, "*");
    assert.equal(
      hooks[AGY_ENTRY].SessionStart[0].command,
      AGY_SESSION_START_CMD,
    );

    const mcp = JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8"));
    const server = mcp.mcpServers[AGY_ENTRY];
    assert.equal(server.command, "sh");
    assert.equal(server.args.at(-1), script);
    assert.match(server.env.AUTONOMOS_SERVER_URL, /^ws\+unix:\/\//);
    assert.equal(server.env.AUTONOMOS_AGENT_TOKEN, undefined);
  });

  it("refuses to overwrite a file that isn't a JSON object", () => {
    const home = mkdtempSync(join(tmpdir(), "aos-agy-bad-"));
    const dir = join(home, ".gemini", "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hooks.json"), "[1,2]");
    assert.throws(() => writeAntigravityConfig(script, { HOME: home }));
    assert.equal(readFileSync(join(dir, "hooks.json"), "utf8"), "[1,2]");
  });
});

describe("agy hook commands outside an autonomOS spawn", () => {
  const run = (cmd: string) =>
    execFileSync("sh", ["-c", cmd], {
      input: "{}",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    });

  it("SessionStart prints {} (inject nothing) and exits 0", () => {
    assert.equal(run(AGY_SESSION_START_CMD).trim(), "{}");
  });

  it("the relay exits 0 silently", () => {
    assert.equal(run(AGY_HOOK_CMD), "");
  });

  it("the MCP entry starts no node process", () => {
    const home = mkdtempSync(join(tmpdir(), "aos-agy-mcp-"));
    writeAntigravityConfig("/does/not/exist.mjs", { HOME: home });
    const { args } = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    ).mcpServers[AGY_ENTRY];
    assert.equal(
      execFileSync("sh", args, { env: { PATH: "/usr/bin:/bin" } }).length,
      0,
    );
  });
});

describe("agy permissions table", () => {
  it("both run-without-asking tool permissions count as never-asks", () => {
    for (const toolPermission of ["always-proceed", "proceed-in-sandbox"])
      assert.equal(
        neverAsks(completePermission("antigravity", { toolPermission })),
        true,
      );
    assert.equal(neverAsks(completePermission("antigravity")), false);
  });

  it("legacy modes round-trip", () => {
    for (const mode of ["ask", "auto", "plan", "bypass"] as const)
      assert.equal(
        legacyModeFor(permissionFromLegacyMode("antigravity", mode)),
        mode,
      );
  });

  it("parses the CLI's own values and rejects anything else", () => {
    assert.ok(parseRuntimePermission("antigravity", "agentMode=plan").ok);
    assert.ok(!parseRuntimePermission("antigravity", "agentMode=bogus").ok);
    assert.ok(!parseRuntimePermission("antigravity", "plan").ok); // two axes
  });

  it("the drift probe maps default to '' and reads agy's rejection", () => {
    assert.equal(agySettingsValue("agentMode", "default"), "");
    assert.equal(agySettingsValue("toolPermission", "strict"), "strict");
    assert.equal(
      agyAcceptsOutput({ code: 0, output: "No MCP servers configured.\n" }),
      true,
    );
    assert.equal(
      agyAcceptsOutput({
        code: 1,
        output:
          'Error: --settings: invalid value for setting "agentMode": agentMode: unrecognized value "bogus"',
      }),
      false,
    );
  });
});
