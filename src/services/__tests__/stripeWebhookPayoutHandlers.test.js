jest.mock('../../lib/pushNotifications', () => ({
  sendPushToDriverIds: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
}));

const { sendPushToDriverIds } = require('../../lib/pushNotifications');
const { handleStripeEvent } = require('../stripeWebhookProcessor');

function buildTx(overrides = {}) {
  return {
    driverPayout: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    driverWallet: {
      update: jest.fn().mockResolvedValue({}),
    },
    driverWalletTransaction: {
      update: jest.fn().mockResolvedValue({}),
    },
    driverNotification: {
      create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
    },
    ...overrides,
  };
}

describe('Stripe payout webhook handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('payout.paid marks transferred payout completed and notifies driver', async () => {
    const payout = {
      id: 'driver-payout-1',
      driverId: 'driver-1',
      walletId: 'wallet-1',
      transactionId: 'txn-1',
      amount: 96.5,
      currency: 'myr',
      stripePayoutId: 'po_1',
      status: 'TRANSFERRED',
    };
    const tx = buildTx();
    tx.driverPayout.findUnique.mockResolvedValue(payout);

    await handleStripeEvent(tx, { type: 'payout.paid', data: { object: { id: 'po_1' } } });

    expect(tx.driverWalletTransaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { status: 'COMPLETED' },
    });
    expect(tx.driverPayout.update).toHaveBeenCalledWith({
      where: { id: 'driver-payout-1' },
      data: { status: 'COMPLETED', failureMessage: null, stripePayoutId: 'po_1' },
    });
    expect(tx.driverNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        driverId: 'driver-1',
        type: 'PAYOUT_PAID',
        title: 'Withdrawal successful',
      }),
    });
    expect(sendPushToDriverIds).toHaveBeenCalledWith(
      ['driver-1'],
      expect.objectContaining({ title: 'Withdrawal successful' }),
      expect.objectContaining({ type: 'PAYOUT_PAID', transactionId: 'txn-1' })
    );
  });

  test('payout.failed refunds wallet and marks payout failed once', async () => {
    const payout = {
      id: 'driver-payout-1',
      driverId: 'driver-1',
      walletId: 'wallet-1',
      transactionId: 'txn-1',
      amount: 96.5,
      currency: 'myr',
      stripePayoutId: 'po_1',
      status: 'TRANSFERRED',
    };
    const tx = buildTx();
    tx.driverPayout.findUnique.mockResolvedValue(payout);

    await handleStripeEvent(tx, {
      type: 'payout.failed',
      data: { object: { id: 'po_1', failure_message: 'Bank rejected transfer' } },
    });

    expect(tx.driverWallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 96.5 } },
    });
    expect(tx.driverWalletTransaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { status: 'FAILED' },
    });
    expect(tx.driverPayout.update).toHaveBeenCalledWith({
      where: { id: 'driver-payout-1' },
      data: { status: 'FAILED', failureMessage: 'Bank rejected transfer' },
    });
    expect(tx.driverNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        driverId: 'driver-1',
        type: 'PAYOUT_FAILED',
      }),
    });
  });

  test('unknown payout id logs warning and leaves database untouched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tx = buildTx();
    tx.driverPayout.findUnique.mockResolvedValue(null);

    await handleStripeEvent(tx, { type: 'payout.paid', data: { object: { id: 'po_unknown' } } });

    expect(warn).toHaveBeenCalledWith('[driver-payout-webhook] payout.paid for unknown payout id', 'po_unknown');
    expect(tx.driverPayout.update).not.toHaveBeenCalled();
    expect(tx.driverNotification.create).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
