const prisma = require('../lib/prisma');

function anonymizedEmail(userId) {
  return `deleted-${userId}@deleted.carryon.local`;
}

async function exportUserAccount(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      addresses: true,
      bookings: {
        include: {
          pickupAddress: true,
          deliveryAddress: true,
          order: true,
          invoice: true,
        },
        orderBy: { createdAt: 'desc' },
      },
      wallet: { include: { transactions: { orderBy: { createdAt: 'desc' } } } },
      userCoupons: { include: { coupon: true } },
      referralsMade: true,
      referralsUsed: true,
      supportTickets: { include: { messages: true } },
      invoices: true,
      pushDevices: true,
      topUpPayments: true,
    },
  });
  if (!user) return null;

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      profileImage: user.profileImage,
      language: user.language,
      referralCode: user.referralCode,
      privacyConsentAt: user.privacyConsentAt,
      privacyPolicyVersion: user.privacyPolicyVersion,
      createdAt: user.createdAt,
    },
    addresses: user.addresses,
    bookings: user.bookings,
    wallet: user.wallet,
    promos: {
      coupons: user.userCoupons,
      referralsMade: user.referralsMade,
      referralsUsed: user.referralsUsed,
    },
    supportTickets: user.supportTickets,
    invoices: user.invoices,
    pushDevices: user.pushDevices,
    topUpPayments: user.topUpPayments,
  };
}

async function anonymizeUserAccount(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  return prisma.$transaction(async (tx) => {
    await tx.pushDevice.deleteMany({ where: { userId } });
    await tx.address.updateMany({
      where: { userId },
      data: {
        contactName: '',
        contactPhone: '',
        contactEmail: '',
        landmark: '',
        label: 'Deleted account address',
      },
    });
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        name: 'Deleted user',
        email: anonymizedEmail(userId),
        phone: '',
        profileImage: null,
        stripeCustomerId: null,
        referralCode: null,
        deletedAt: new Date(),
      },
    });
    return {
      id: updated.id,
      deletedAt: updated.deletedAt,
      retainedRecords: ['bookings', 'wallet', 'walletTransactions', 'invoices', 'topUpPayments'],
    };
  });
}

async function recordPrivacyConsent(userId, policyVersion) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      privacyConsentAt: new Date(),
      privacyPolicyVersion: String(policyVersion || 'current'),
    },
    select: {
      id: true,
      privacyConsentAt: true,
      privacyPolicyVersion: true,
    },
  });
}

module.exports = {
  anonymizedEmail,
  exportUserAccount,
  anonymizeUserAccount,
  recordPrivacyConsent,
};
