const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { getStripe, stripeCurrency } = require('../lib/stripe');
const { toMinorUnits, fromMinorUnits } = require('../lib/money');

const router = Router();
router.use(authenticateDriver, requireDriver);

function requirementsPayload(account) {
  return {
    currentlyDue: account.requirements?.currently_due || [],
    eventuallyDue: account.requirements?.eventually_due || [],
    pastDue: account.requirements?.past_due || [],
    disabledReason: account.requirements?.disabled_reason || null,
  };
}

async function syncDriverAccountStatus(driverId, account) {
  return prisma.driver.update({
    where: { id: driverId },
    data: {
      stripeConnectAccountId: account.id,
      stripeDetailsSubmitted: !!account.details_submitted,
      stripePayoutsEnabled: !!account.payouts_enabled,
      stripeRequirements: requirementsPayload(account),
    },
  });
}

async function ensureAccount(driver) {
  const stripe = getStripe();
  if (driver.stripeConnectAccountId) {
    const account = await stripe.accounts.retrieve(driver.stripeConnectAccountId);
    await syncDriverAccountStatus(driver.id, account);
    return account;
  }

  const account = await stripe.accounts.create({
    type: 'express',
    country: process.env.STRIPE_CONNECT_COUNTRY || 'MY',
    email: driver.email || undefined,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
    },
    metadata: {
      driverId: driver.id,
    },
  });
  await syncDriverAccountStatus(driver.id, account);
  return account;
}

router.post('/account', async (req, res, next) => {
  try {
    const account = await ensureAccount(req.driver);
    res.json({
      success: true,
      data: {
        accountId: account.id,
        detailsSubmitted: !!account.details_submitted,
        payoutsEnabled: !!account.payouts_enabled,
        requirements: requirementsPayload(account),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/onboarding-link', async (req, res, next) => {
  try {
    const stripe = getStripe();
    const account = await ensureAccount(req.driver);
    const returnUrl = process.env.STRIPE_CONNECT_RETURN_URL || 'carryon-driver://stripe-connect/return';
    const refreshUrl = process.env.STRIPE_CONNECT_REFRESH_URL || 'carryon-driver://stripe-connect/refresh';
    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    res.json({ success: true, data: { url: link.url, expiresAt: link.expires_at } });
  } catch (err) {
    next(err);
  }
});

router.get('/status', async (req, res, next) => {
  try {
    let account = null;
    if (req.driver.stripeConnectAccountId) {
      account = await getStripe().accounts.retrieve(req.driver.stripeConnectAccountId);
      await syncDriverAccountStatus(req.driver.id, account);
    }
    res.json({
      success: true,
      data: {
        accountId: account?.id || req.driver.stripeConnectAccountId || null,
        detailsSubmitted: !!account?.details_submitted || !!req.driver.stripeDetailsSubmitted,
        payoutsEnabled: !!account?.payouts_enabled || !!req.driver.stripePayoutsEnabled,
        requirements: account ? requirementsPayload(account) : (req.driver.stripeRequirements || null),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/withdraw', async (req, res, next) => {
  try {
    const amountMinor = toMinorUnits(req.body?.amount);
    if (amountMinor <= 0) return next(new AppError('Invalid amount', 400));

    const driver = await prisma.driver.findUnique({ where: { id: req.driver.id } });
    if (!driver?.stripeConnectAccountId) {
      return next(new AppError('Set up Stripe payouts before withdrawing', 400));
    }

    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(driver.stripeConnectAccountId);
    await syncDriverAccountStatus(driver.id, account);
    if (!account.payouts_enabled) {
      return next(new AppError('Stripe payouts are not enabled for this driver yet', 400));
    }

    const wallet = await prisma.driverWallet.findUnique({ where: { driverId: driver.id } });
    const amount = fromMinorUnits(amountMinor);
    if (!wallet || wallet.balance < amount) {
      return next(new AppError('Insufficient balance', 400));
    }

    const currency = stripeCurrency();
    const result = await prisma.$transaction(async (tx) => {
      const latestWallet = await tx.driverWallet.findUnique({ where: { driverId: driver.id } });
      if (!latestWallet || latestWallet.balance < amount) {
        throw new AppError('Insufficient balance', 400);
      }

      const pending = await tx.driverPayout.create({
        data: {
          driverId: driver.id,
          walletId: latestWallet.id,
          amount,
          amountMinor,
          currency,
          status: 'PENDING',
        },
      });

      await tx.driverWallet.update({
        where: { id: latestWallet.id },
        data: { balance: { decrement: amount } },
      });

      const transaction = await tx.driverWalletTransaction.create({
        data: {
          walletId: latestWallet.id,
          type: 'WITHDRAWAL',
          amount: -amount,
          description: `Stripe withdrawal of RM ${amount.toFixed(2)}`,
          status: 'PENDING',
        },
      });

      return { pending, transaction };
    });

    try {
      const transfer = await stripe.transfers.create({
        amount: amountMinor,
        currency,
        destination: account.id,
        metadata: {
          driverId: driver.id,
          payoutId: result.pending.id,
          transactionId: result.transaction.id,
        },
      }, {
        idempotencyKey: `driver-withdrawal-${result.pending.id}`,
      });

      const updatedTransaction = await prisma.$transaction(async (tx) => {
        const transaction = await tx.driverWalletTransaction.update({
          where: { id: result.transaction.id },
          data: {
            status: 'COMPLETED',
            stripeTransferId: transfer.id,
          },
        });
        await tx.driverPayout.update({
          where: { id: result.pending.id },
          data: {
            transactionId: transaction.id,
            stripeTransferId: transfer.id,
            status: 'COMPLETED',
          },
        });
        return transaction;
      });

      res.json({ success: true, data: updatedTransaction });
    } catch (stripeErr) {
      await prisma.$transaction([
        prisma.driverWallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount } },
        }),
        prisma.driverWalletTransaction.update({
          where: { id: result.transaction.id },
          data: { status: 'FAILED' },
        }),
        prisma.driverPayout.update({
          where: { id: result.pending.id },
          data: {
            status: 'FAILED',
            failureMessage: stripeErr.message,
          },
        }),
      ]);
      return next(new AppError(stripeErr.message || 'Stripe transfer failed', 400));
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
