// ── Audit Log Module ────────────────────────────────────────
// Transaction-aware record of critical business mutations.

function normalizeActor(actor = {}) {
  return {
    actorId: String(actor.actorId || actor.userId || actor.driverId || actor.adminId || 'system'),
    actorType: String(actor.actorType || 'SYSTEM'),
  };
}

async function recordAudit(tx, event) {
  const actor = normalizeActor(event.actor);
  return tx.auditLog.create({
    data: {
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: event.action,
      entityType: event.entityType,
      entityId: String(event.entityId),
      oldValue: event.oldValue === undefined ? undefined : event.oldValue,
      newValue: event.newValue === undefined ? undefined : event.newValue,
    },
  });
}

module.exports = { recordAudit };
