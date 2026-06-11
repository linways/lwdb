/**
 * Interactive write-approval queue. An agent requests approval for one specific
 * statement; a human approves THAT exact SQL in the desktop app (or any client
 * hitting the daemon); the write then executes server-side, exactly once.
 *
 * This is a per-write consent path that complements the global agent-writes
 * switch — the human never has to pre-enable writes, they approve each one live.
 * Lives in the daemon process so the agent and the approving UI share one queue.
 * In-memory and ephemeral: a pending approval that outlives the process is moot.
 */
import { randomUUID } from 'node:crypto';
import { appError, Codes } from './errors.mjs';

function publicView(item) {
  return {
    id: item.id,
    server: item.server,
    db: item.db,
    sql: item.sql,
    status: item.status,
    requestedAt: item.requestedAt,
    resolvedAt: item.resolvedAt ?? null,
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
  };
}

export class ApprovalQueue {
  constructor() {
    this.items = new Map();
  }

  create({ server, db = null, sql }) {
    const item = {
      id: `apr_${randomUUID()}`,
      server,
      db,
      sql,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    return publicView(item);
  }

  /** Pending approvals only — the worklist a human UI renders. */
  list() {
    return [...this.items.values()].filter((i) => i.status === 'pending').map(publicView);
  }

  get(id) {
    const item = this.items.get(id);
    return item ? publicView(item) : null;
  }

  /**
   * Resolve a pending approval. On 'approve', runs `runner(item)` and stores its
   * result (or captures a thrown error as status 'error'); on 'deny', marks it
   * denied without running anything. Idempotency is enforced: a non-pending
   * approval throws CONFLICT so a write can never execute twice.
   */
  async resolve(id, decision, runner) {
    if (decision !== 'approve' && decision !== 'deny') {
      throw appError(Codes.BAD_REQUEST, `decision must be 'approve' or 'deny' (got '${decision}')`);
    }
    const item = this.items.get(id);
    if (!item) throw appError(Codes.NOT_FOUND, `Approval not found: ${id}`);
    if (item.status !== 'pending') throw appError(Codes.CONFLICT, `Approval ${id} is already ${item.status}`);

    if (decision === 'deny') {
      item.status = 'denied';
      item.resolvedAt = new Date().toISOString();
      return publicView(item);
    }

    try {
      item.result = await runner(item);
      item.status = 'approved';
    } catch (e) {
      item.status = 'error';
      item.error = { code: e.code || Codes.DB_ERROR, message: e.message };
    }
    item.resolvedAt = new Date().toISOString();
    return publicView(item);
  }
}
