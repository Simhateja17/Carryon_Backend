const { reserveBookingPayment } = require('../walletLedger');

describe('Wallet Ledger — Booking payment reservation', () => {
  test('debits wallet and records the booking reference directly', async () => {
    const tx = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balance: 100 }),
        update: jest.fn().mockResolvedValue({ id: 'wallet-1', balance: 75 }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'txn-1' }),
      },
    };

    await reserveBookingPayment(tx, 'user-1', 'booking-1', 'ORD-000123', 25);

    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { decrement: 25 } },
    });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: {
        walletId: 'wallet-1',
        type: 'PAYMENT',
        amount: -25,
        description: 'Payment for booking ORD-000123',
        referenceId: 'booking-1',
      },
    });
  });

  test('rejects payment when wallet balance is insufficient', async () => {
    const tx = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balance: 10 }),
        update: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
      },
    };

    await expect(
      reserveBookingPayment(tx, 'user-1', 'booking-1', 'ORD-000123', 25)
    ).rejects.toMatchObject({
      statusCode: 402,
      details: {
        currentBalance: 10,
        amountDue: 25,
        shortfall: 15,
        currency: 'MYR',
      },
    });
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });
});
