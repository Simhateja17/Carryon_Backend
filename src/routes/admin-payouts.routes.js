const { Router } = require('express');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parsePagination } = require('../lib/pagination');
const { recordAudit } = require('../services/auditLog');
const {
  failManualDriverPayout,
  maskedBankDestination,
  payoutRequestedAmount,
} = require('../services/manualDriverPayouts');

const router = Router();
const PAYOUT_STATUSES = new Set(['PENDING', 'COMPLETED', 'FAILED', 'TRANSFERRED']);

function adminId(actor = {}) {
  return String(actor.actorId || actor.userId || actor.adminId || 'system');
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return PAYOUT_STATUSES.has(status) ? status : '';
}

function serializePayout(payout, transaction = null, { revealDestination = false } = {}) {
  const requestedAmount = payoutRequestedAmount(transaction, payout);
  const feeAmount = transaction?.platformFeeAmount || 0;
  const snapshot = payout.bankSnapshot || {};
  return {
    ...payout,
    requestedAmount,
    feeAmount,
    transferAmount: payout.amount,
    transaction: transaction || null,
    driver: payout.driver || null,
    bankDestination: revealDestination ? snapshot : maskedBankDestination(snapshot),
  };
}

async function transactionsByIdFor(payouts) {
  const ids = payouts.map((payout) => payout.transactionId).filter(Boolean);
  if (ids.length === 0) return new Map();
  const transactions = await prisma.driverWalletTransaction.findMany({
    where: { id: { in: ids } },
  });
  return new Map(transactions.map((transaction) => [transaction.id, transaction]));
}

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const status = normalizeStatus(req.query.status);
    const where = status ? { status } : {};

    const [total, payouts] = await Promise.all([
      prisma.driverPayout.count({ where }),
      prisma.driverPayout.findMany({
        where,
        include: {
          driver: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    const transactionsById = await transactionsByIdFor(payouts);

    res.json({
      success: true,
      data: {
        items: payouts.map((payout) => serializePayout(payout, payout.transactionId ? transactionsById.get(payout.transactionId) : null)),
        total,
        page,
        pageSize: limit,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/mark-paid', async (req, res, next) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    if (reference.length < 3) {
      return next(new AppError('reference is required when marking a payout paid', 400));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const payout = await tx.driverPayout.findUnique({ where: { id: req.params.id } });
      if (!payout) throw new AppError('Payout not found', 404);
      if (payout.status === 'COMPLETED') return payout;
      if (payout.status === 'FAILED') throw new AppError('Failed payouts cannot be marked paid.', 400);

      if (payout.transactionId) {
        await tx.driverWalletTransaction.update({
          where: { id: payout.transactionId },
          data: {
            status: 'COMPLETED',
            manualReference: reference,
          },
        });
      }

      const paid = await tx.driverPayout.update({
        where: { id: payout.id },
        data: {
          status: 'COMPLETED',
          manualReference: reference,
          paidAt: new Date(),
          paidByAdminId: adminId(req.adminActor),
          failureMessage: null,
        },
      });

      await recordAudit(tx, {
        actor: req.adminActor,
        action: 'DRIVER_PAYOUT_MARKED_PAID',
        entityType: 'DriverPayout',
        entityId: payout.id,
        oldValue: { status: payout.status },
        newValue: { status: 'COMPLETED', reference },
      });

      return paid;
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/fail', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      return next(new AppError('reason is required when failing a payout', 400));
    }

    const updated = await prisma.$transaction((tx) => failManualDriverPayout(tx, req.params.id, reason, req.adminActor));
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/destination/reveal', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      return next(new AppError('A reveal reason is required', 400));
    }

    const payout = await prisma.driverPayout.findUnique({
      where: { id: req.params.id },
      include: {
        driver: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!payout) return next(new AppError('Payout not found', 404));

    await recordAudit(prisma, {
      actor: req.adminActor,
      action: 'DRIVER_PAYOUT_DESTINATION_REVEALED',
      entityType: 'DriverPayout',
      entityId: payout.id,
      newValue: { reason: reason.slice(0, 160) },
    });

    res.json({
      success: true,
      data: {
        payoutId: payout.id,
        bankDestination: payout.bankSnapshot || {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
