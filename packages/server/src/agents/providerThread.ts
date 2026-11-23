/**
 * Persist the CLI's own conversation id for an agent (`providerThreadId`), so a
 * later restart resumes that conversation instead of starting a new one.
 *
 * Shared by the two places a CLI reports its id after spawn: the Codex
 * app-server watch (gateway/index.ts) and the hook route, for providers whose
 * hooks carry it (Antigravity's `conversationId`, via threadIdFromEvent).
 * Deduped — only writes when the id actually changes.
 */

import { emitAgentDelta } from "../events/agents.js";
import { getAgent, patchAgent } from "./store.js";

export function persistProviderThreadId(
  agentId: string,
  threadId: string,
  label: string,
): void {
  const agent = getAgent(agentId);
  if (!agent || agent.providerThreadId === threadId) return;
  const result = patchAgent(agentId, { providerThreadId: threadId });
  if (result === undefined || result === "stale") {
    // Fires about once per agent lifetime; a dropped write here means resume
    // capability is silently lost until the next restart. Surface it.
    console.warn(
      `[${label}] failed to persist thread id for ${agentId.slice(0, 8)} (${result ?? "agent missing"}) — conversation resume may not work on next restart`,
    );
    return;
  }
  // Keep optimistic-concurrency clients in sync with the version bump (matches
  // the write-then-emit pattern of other patchAgent callers), so a dashboard
  // holding a stale version token doesn't 409 on its next edit.
  emitAgentDelta({
    type: "agent.updated",
    id: result.id,
    patch: { providerThreadId: threadId },
    version: result.version,
  });
}
