import type { AppDb } from "../../db/client.ts";
import { auditLog } from "../../db/schema.ts";

// "mcp" is a tool call dispatched through the MCP tool contract
// (src/server/mcp/server.ts) — distinct from "agent" (the in-console
// text-chat tool loop) so the audit trail can tell an external MCP client
// apart from the console's own chat agent, even though both ultimately call
// the same AGENT_TOOLS.
export type AuditActor = "human" | "agent" | "mcp";

/**
 * Every mutating console action — human or agent-triggered — writes here.
 * CONSOLE_SPEC.md's threat model requires this to be unconditional: "a
 * directive quietly suppressing AUDIT SUMMARY output" is structurally
 * impossible, and the same guarantee applies to the audit_log itself —
 * nothing here is optional or best-effort.
 */
export async function writeAuditLog(
  db: AppDb,
  actor: AuditActor,
  action: string,
  subject: string,
  detail: Record<string, unknown>,
  now: () => number = Date.now,
): Promise<void> {
  await db
    .insert(auditLog)
    .values({ at: new Date(now()).toISOString(), actor, action, subject, detailJson: JSON.stringify(detail) })
    .run();
}
