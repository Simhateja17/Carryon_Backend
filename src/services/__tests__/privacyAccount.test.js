jest.mock('../../lib/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
}));

const prisma = require('../../lib/prisma');
const {
  anonymizeUserAccount,
  exportUserAccount,
  recordPrivacyConsent,
} = require('../privacyAccount');

describe('privacy account service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('exports user-owned account data shape', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'User',
      email: 'u@example.com',
      phone: '123',
      profileImage: null,
      language: 'en',
      referralCode: 'ABC',
      privacyConsentAt: null,
      privacyPolicyVersion: null,
      createdAt: new Date('2026-04-28T00:00:00Z'),
      addresses: [],
      bookings: [],
      wallet: null,
      userCoupons: [],
      referralsMade: [],
      referralsUsed: [],
      supportTickets: [],
      invoices: [],
      pushDevices: [],
      topUpPayments: [],
    });

    const result = await exportUserAccount('user-1');

    expect(result.profile.email).toBe('u@example.com');
    expect(result).toHaveProperty('wallet');
    expect(result).toHaveProperty('bookings');
    expect(result).toHaveProperty('pushDevices');
  });

  test('anonymizes direct identifiers and clears push devices while retaining records', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    const tx = {
      pushDevice: { deleteMany: jest.fn() },
      address: { updateMany: jest.fn() },
      user: {
        update: jest.fn().mockResolvedValue({ id: 'user-1', deletedAt: new Date('2026-04-28T00:00:00Z') }),
      },
    };
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const result = await anonymizeUserAccount('user-1');

    expect(tx.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Deleted user',
        email: 'deleted-user-1@deleted.carryon.local',
        phone: '',
        profileImage: null,
      }),
    }));
    expect(result.retainedRecords).toContain('bookings');
    expect(result.retainedRecords).toContain('wallet');
  });

  test('records privacy consent version and timestamp', async () => {
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      privacyConsentAt: new Date('2026-04-28T00:00:00Z'),
      privacyPolicyVersion: '2026-04',
    });

    const result = await recordPrivacyConsent('user-1', '2026-04');

    expect(result.privacyPolicyVersion).toBe('2026-04');
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: expect.objectContaining({ privacyPolicyVersion: '2026-04' }),
    }));
  });
});
