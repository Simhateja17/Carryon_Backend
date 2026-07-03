const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticateDriver, requireDriver } = require('../middleware/driverAuth');
const { AppError } = require('../middleware/errorHandler');
const { stripeCurrency } = require('../lib/stripe');
const { calculateDriverWithdrawal } = require('../lib/driverPayoutFees');
const { parseBody } = require('../lib/validation');
const { driverWithdrawSchema } = require('../validation/financialSchemas');
const {
  assertApprovedBankDetails,
  bankDetailsSnapshot,
  maskedBankDestination,
} = require('../services/manualDriverPayouts');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const router = Router();
router.use(authenticateDriver, requireDriver);

function formatMoney(value, currency = stripeCurrency()) {
  return `${String(currency || 'myr').toUpperCase()} ${Number(value || 0).toFixed(2)}`;
}

async function buildPayoutReceiptPdf({ driver, transaction, payout }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.012, 0.251, 0.58);
  const dark = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.39, 0.45, 0.55);
  const currency = payout?.currency || stripeCurrency();
  const requestedAmount = transaction.grossAmount || Math.abs(transaction.amount || 0);
  const feeAmount = transaction.platformFeeAmount || 0;
  const transferAmount = payout?.amount || Math.max(0, requestedAmount - feeAmount);

  page.drawText('CarryOn', { x: 48, y: 780, size: 24, font: bold, color: blue });
  page.drawText('Driver withdrawal receipt', { x: 48, y: 752, size: 14, font, color: dark });

  const rows = [
    ['Driver', driver.name || driver.email || driver.id],
    ['Driver ID', driver.id],
    ['Transaction ID', transaction.id],
    ['Receipt date', new Date().toISOString().slice(0, 10)],
    ['Withdrawal date', new Date(transaction.createdAt).toISOString().slice(0, 10)],
    ['Requested amount', formatMoney(requestedAmount, currency)],
    ['Fee amount', formatMoney(feeAmount, currency)],
    ['Transfer amount', formatMoney(transferAmount, currency)],
    ['Status', transaction.status],
    ['Manual reference', transaction.manualReference || payout?.manualReference || '-'],
    ['Paid at', payout?.paidAt ? new Date(payout.paidAt).toISOString().slice(0, 10) : '-'],
    ['Support', process.env.SUPPORT_EMAIL || 'support@carryon.my'],
  ];

  let y = 700;
  for (const [label, value] of rows) {
    page.drawText(label, { x: 48, y, size: 10, font: bold, color: muted });
    page.drawText(String(value || '-'), { x: 190, y, size: 11, font, color: dark });
    y -= 26;
  }

  page.drawLine({ start: { x: 48, y: 112 }, end: { x: 547, y: 112 }, thickness: 1, color: rgb(0.88, 0.9, 0.94) });
  page.drawText('This receipt confirms a CarryOn driver wallet withdrawal request processed manually by CarryOn operations.', {
    x: 48,
    y: 88,
    size: 9,
    font,
    color: muted,
  });

  return Buffer.from(await pdfDoc.save()).toString('base64');
}

async function payoutForTransaction(transactionId) {
  if (!transactionId) return null;
  return prisma.driverPayout.findUnique({ where: { transactionId } });
}

router.post('/account', async (req, res, next) => {
  try {
    res.status(410).json({ success: false, message: 'Stripe driver payout setup is disabled. Bank payout details are reviewed manually.' });
  } catch (err) {
    next(err);
  }
});

router.post('/onboarding-link', async (req, res, next) => {
  try {
    res.status(410).json({ success: false, message: 'Stripe onboarding links are disabled. Update bank payout details in onboarding or driver profile.' });
  } catch (err) {
    next(err);
  }
});

router.get('/status', async (req, res, next) => {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: req.driver.id } });
    const hasBankDetails = !!(driver?.bankName && driver?.bankAccountHolder && driver?.bankAccountNumber);
    const bankApproved = hasBankDetails && driver.bankDetailsStatus === 'APPROVED';
    res.json({
      success: true,
      data: {
        accountId: null,
        detailsSubmitted: hasBankDetails,
        payoutsEnabled: bankApproved,
        requirements: {
          currentlyDue: hasBankDetails ? [] : ['bankName', 'bankAccountHolder', 'bankAccountNumber'],
          eventuallyDue: [],
          pastDue: driver?.bankDetailsStatus === 'REJECTED' ? ['bankDetailsReview'] : [],
          disabledReason: bankApproved ? null : 'bank_details_review_required',
        },
        bankDetailsStatus: driver?.bankDetailsStatus || 'PENDING',
        bankDetailsRejectionReason: driver?.bankDetailsRejectionReason || null,
        bankDestination: maskedBankDestination(bankDetailsSnapshot(driver || {})),
        minimumWithdrawalAmount: calculateDriverWithdrawal(0).minimumAmount,
        withdrawalFeeFlat: Number(process.env.DRIVER_WITHDRAWAL_FEE_FLAT || 0),
        withdrawalFeeRate: Number(process.env.DRIVER_WITHDRAWAL_FEE_RATE || 0),
        testModeOnly: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/receipt/:transactionId', async (req, res, next) => {
  try {
    const transaction = await prisma.driverWalletTransaction.findUnique({
      where: { id: req.params.transactionId },
      include: {
        wallet: {
          include: { driver: true },
        },
      },
    });

    if (!transaction || transaction.wallet?.driverId !== req.driver.id || transaction.type !== 'WITHDRAWAL') {
      return next(new AppError('Withdrawal transaction not found', 404));
    }

    const payout = await payoutForTransaction(transaction.id);
    const base64 = await buildPayoutReceiptPdf({
      driver: transaction.wallet.driver || req.driver,
      transaction,
      payout,
    });

    res.json({
      success: true,
      data: {
        url: `data:application/pdf;base64,${base64}`,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/withdraw', async (req, res, next) => {
  try {
    const { amount: requestedAmount } = parseBody(driverWithdrawSchema, req.body);
    const withdrawal = calculateDriverWithdrawal(requestedAmount);
    if (withdrawal.requestedMinor < withdrawal.minimumMinor) {
      return next(new AppError(`Minimum withdrawal is RM ${withdrawal.minimumAmount.toFixed(2)}`, 400));
    }
    if (withdrawal.transferMinor <= 0) {
      return next(new AppError('Withdrawal amount must exceed the payout fee', 400));
    }

    const driver = await prisma.driver.findUnique({ where: { id: req.driver.id } });
    assertApprovedBankDetails(driver);

    const wallet = await prisma.driverWallet.findUnique({ where: { driverId: driver.id } });
    const amount = withdrawal.requestedAmount;
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
          amount: withdrawal.transferAmount,
          amountMinor: withdrawal.transferMinor,
          currency,
          status: 'PENDING',
          bankSnapshot: bankDetailsSnapshot(driver),
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
          grossAmount: withdrawal.requestedAmount,
          platformFeeAmount: withdrawal.feeAmount,
          description: withdrawal.feeMinor > 0
            ? `Manual bank withdrawal of RM ${withdrawal.transferAmount.toFixed(2)} after RM ${withdrawal.feeAmount.toFixed(2)} fee`
            : `Manual bank withdrawal of RM ${amount.toFixed(2)}`,
          status: 'PENDING',
        },
      });

      await tx.driverPayout.update({
        where: { id: pending.id },
        data: {
          transactionId: transaction.id,
          status: 'PENDING',
        },
      });
      return transaction;
    });

    res.json({
      success: true,
      data: {
        ...result,
        requestedAmount: withdrawal.requestedAmount,
        feeAmount: withdrawal.feeAmount,
        transferAmount: withdrawal.transferAmount,
        currency,
        message: 'Withdrawal request submitted. CarryOn operations will process the bank payout manually.',
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
