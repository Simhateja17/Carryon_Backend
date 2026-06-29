jest.mock('../../lib/pushNotifications', () => ({
  sendPushToDriverIds: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
}));

const { syncConnectedAccount } = require('../stripeWebhookProcessor');

describe('Stripe account.updated payout setup notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function txWithPrior(prior, existingNotification = null) {
    return {
      driver: {
        findUnique: jest.fn().mockResolvedValue(prior),
        updateMany: jest.fn().mockResolvedValue({ count: prior ? 1 : 0 }),
      },
      driverNotification: {
        findFirst: jest.fn().mockResolvedValue(existingNotification),
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
      },
    };
  }

  test('notifies once when payouts move from enabled to disabled with past-due requirements', async () => {
    const tx = txWithPrior({
      id: 'driver-1',
      stripePayoutsEnabled: true,
    });

    await syncConnectedAccount(tx, {
      id: 'acct_1',
      details_submitted: true,
      payouts_enabled: false,
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: ['external_account'],
        disabled_reason: 'requirements.past_due',
      },
    });

    expect(tx.driver.updateMany).toHaveBeenCalled();
    expect(tx.driverNotification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ driverId: 'driver-1', type: 'PAYOUT_SETUP_NEEDED' }),
    }));
    expect(tx.driverNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        driverId: 'driver-1',
        type: 'PAYOUT_SETUP_NEEDED',
        title: 'Update your payout details',
      }),
    });
  });

  test('does not notify without past-due requirements', async () => {
    const tx = txWithPrior({ id: 'driver-1', stripePayoutsEnabled: true });

    await syncConnectedAccount(tx, {
      id: 'acct_1',
      details_submitted: true,
      payouts_enabled: false,
      requirements: { past_due: [] },
    });

    expect(tx.driverNotification.create).not.toHaveBeenCalled();
  });

  test('does not notify again within the 24 hour idempotency window', async () => {
    const tx = txWithPrior(
      { id: 'driver-1', stripePayoutsEnabled: true },
      { id: 'existing-notification' }
    );

    await syncConnectedAccount(tx, {
      id: 'acct_1',
      details_submitted: true,
      payouts_enabled: false,
      requirements: { past_due: ['external_account'] },
    });

    expect(tx.driverNotification.create).not.toHaveBeenCalled();
  });
});
