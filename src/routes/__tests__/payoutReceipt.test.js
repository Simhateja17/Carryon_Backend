jest.mock('../../lib/prisma', () => ({
  driverWalletTransaction: {
    findUnique: jest.fn(),
  },
  driverPayout: {
    findUnique: jest.fn(),
  },
}));

jest.mock('../../middleware/driverAuth', () => ({
  authenticateDriver: (req, _res, next) => {
    req.driver = { id: 'driver-1', name: 'Alex Driver', email: 'alex@example.com' };
    next();
  },
  requireDriver: (_req, _res, next) => next(),
}));

jest.mock('../../lib/stripe', () => ({
  getStripe: jest.fn(),
  isStripeLiveMode: jest.fn(() => false),
  stripeCurrency: jest.fn(() => 'myr'),
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

  const middlewareHandlers = router.stack
    .filter((layer) => !layer.route)
    .map((layer) => layer.handle);
  const routeLayer = router.stack.find((layer) => (
    layer.route &&
    layer.route.path === routePath &&
    layer.route.methods[method.toLowerCase()]
  ));
  if (!routeLayer) throw new Error(`Route not found: ${method} ${routePath}`);

  const handlers = [...middlewareHandlers, ...routeLayer.route.stack.map((layer) => layer.handle)];
  let capturedError = null;
  for (const handler of handlers) {
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

describe('driver payout receipt route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a PDF data URL for an owned withdrawal transaction', async () => {
    prisma.driverWalletTransaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      walletId: 'wallet-1',
      type: 'WITHDRAWAL',
      amount: -100,
      grossAmount: 100,
      platformFeeAmount: 2,
      stripeTransferId: 'tr_1',
      status: 'COMPLETED',
      createdAt: new Date('2026-06-29T00:00:00Z'),
      wallet: {
        id: 'wallet-1',
        driverId: 'driver-1',
        driver: { id: 'driver-1', name: 'Alex Driver', email: 'alex@example.com' },
      },
    });
    prisma.driverPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      amount: 98,
      currency: 'myr',
      stripeTransferId: 'tr_1',
      stripePayoutId: 'po_1',
    });

    const response = await invokeRoute(require('../driver-payouts.routes'), 'GET', '/receipt/:transactionId', {
      params: { transactionId: 'txn-1' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.url).toMatch(/^data:application\/pdf;base64,/);
  });

  test('returns 404 for a non-withdrawal transaction', async () => {
    prisma.driverWalletTransaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: 'DELIVERY_EARNING',
      wallet: { driverId: 'driver-1' },
    });

    const response = await invokeRoute(require('../driver-payouts.routes'), 'GET', '/receipt/:transactionId', {
      params: { transactionId: 'txn-1' },
    });

    expect(response.status).toBe(404);
  });
});
