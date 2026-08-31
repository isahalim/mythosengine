import type { AppDb } from "../../db/client.ts";
import { auditLog } from "../../db/schema.ts";

// "mcp" is a tool call dispatched through the MCP tool contract
// (src/server/mcp/server.ts) — distinct from "agent" (the in-console
// text-chat tool loop) so the audit trail can tell an external MCP client
// apart from the console's own chat agent, even though both ultimately call
// the same AGENT_TOOLS.
// "pipeline" is the GitHub Actions runner writing through
// POST /internal/d1/batch (src/server/internal/d1-batch.ts) — the only
// actor that is not a person or a tool loop acting for one, and worth
// telling apart precisely because it holds a key that can run SQL.
export type AuditActor = "human" | "agent" | "mcp" | "pipeline";

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
