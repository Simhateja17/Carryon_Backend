jest.mock('../../lib/prisma', () => ({
  driver: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  driverPayout: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  driverWalletTransaction: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../services/adminDriverReview', () => ({
  DRIVER_DETAIL_INCLUDE: {},
  DRIVER_REVIEW_INCLUDE: {},
  PII_FIELDS: new Set(),
  detailProjection: jest.fn((driver) => driver),
  driverListProjection: jest.fn((driver) => driver),
  listDriverReviewCandidates: jest.fn(),
  signDriverDocuments: jest.fn(),
}));

jest.mock('../../services/adminDriverVerification', () => ({
  updateDriverVerificationDecision: jest.fn(),
}));

jest.mock('../../services/adminDriverRegistration', () => ({
  createAdminDriverRegistration: jest.fn(),
}));

jest.mock('../../services/auditLog', () => ({
  recordAudit: jest.fn(),
}));

const prisma = require('../../lib/prisma');

async function invokeRoute(router, method, routePath, reqOverrides = {}) {
  const req = {
    method: method.toUpperCase(),
    originalUrl: routePath,
    params: {},
    body: {},
    query: {},
    headers: {},
    ...reqOverrides,
  };
  let statusCode = 200;
  let responseBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  const routeLayer = router.stack.find((layer) => (
    layer.route &&
    layer.route.path === routePath &&
    layer.route.methods[method.toLowerCase()]
  ));
  if (!routeLayer) throw new Error(`Route not found: ${method} ${routePath}`);

  let capturedError = null;
  for (const handler of routeLayer.route.stack.map((layer) => layer.handle)) {
    if (capturedError || responseBody !== undefined) break;
    await new Promise((resolve) => {
      const next = (err) => {
        if (err) capturedError = err;
        resolve();
      };
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(resolve).catch((err) => {
          capturedError = err;
          resolve();
        });
      } else if (handler.length < 3) {
        resolve();
      }
    });
  }

  if (capturedError) {
    return { status: capturedError.statusCode || 500, body: { success: false, message: capturedError.message } };
  }
  return { status: statusCode, body: responseBody };
}

describe('admin driver payouts route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns paginated payout rows joined with wallet transactions', async () => {
    prisma.driver.findUnique.mockResolvedValue({ id: 'driver-1' });
    prisma.driverPayout.count.mockResolvedValue(1);
    prisma.driverPayout.findMany.mockResolvedValue([
      {
        id: 'payout-1',
        driverId: 'driver-1',
        transactionId: 'txn-1',
        amount: 98,
        currency: 'myr',
        status: 'TRANSFERRED',
        createdAt: new Date('2026-06-29T00:00:00Z'),
      },
    ]);
    prisma.driverWalletTransaction.findMany.mockResolvedValue([
      {
        id: 'txn-1',
        grossAmount: 100,
        platformFeeAmount: 2,
      },
    ]);

    const response = await invokeRoute(require('../admin-drivers.routes'), 'GET', '/:driverId/payouts', {
      params: { driverId: 'driver-1' },
      query: { page: '1', limit: '10' },
    });

    expect(response.status).toBe(200);
    expect(prisma.driverPayout.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { driverId: 'driver-1' },
      skip: 0,
      take: 10,
    }));
    expect(response.body.data.items[0]).toMatchObject({
      requestedAmount: 100,
      feeAmount: 2,
      transferAmount: 98,
      transaction: { id: 'txn-1' },
    });
  });

  test('returns 404 for missing driver', async () => {
    prisma.driver.findUnique.mockResolvedValue(null);

    const response = await invokeRoute(require('../admin-drivers.routes'), 'GET', '/:driverId/payouts', {
      params: { driverId: 'missing-driver' },
    });

    expect(response.status).toBe(404);
  });
});
