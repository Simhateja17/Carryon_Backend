jest.mock('../../lib/prisma', () => ({
  booking: {
    findUnique: jest.fn(),
  },
  bookingAdjustment: {
    findMany: jest.fn(),
  },
  invoice: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
}));

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { userId: 'user-1', email: 'customer@example.com', name: 'Customer' };
    next();
  },
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
    return {
      status: capturedError.statusCode || 500,
      body: {
        success: false,
        message: capturedError.statusCode ? capturedError.message : 'Internal server error',
      },
    };
  }
  return { status: statusCode, body: responseBody };
}

describe('invoice routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('generated invoice includes applied booking adjustments', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      userId: 'user-1',
      finalPrice: 20,
      estimatedPrice: 20,
      discountAmount: 0,
      invoice: null,
    });
    prisma.bookingAdjustment.findMany.mockResolvedValue([
      {
        id: 'adjustment-1',
        bookingId: 'booking-1',
        type: 'PICKUP_WAIT_TIME',
        amount: 1.5,
        description: 'Pickup wait-time charge',
        status: 'APPLIED',
      },
    ]);
    prisma.invoice.create.mockResolvedValue({
      id: 'invoice-1',
      bookingId: 'booking-1',
      total: 21.5,
    });

    const response = await invokeRoute(require('../invoice.routes'), 'POST', '/:bookingId', {
      params: { bookingId: 'booking-1' },
    });

    expect(response.status).toBe(201);
    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: 'booking-1',
        subtotal: 20.28,
        tax: 1.22,
        total: 21.5,
      }),
    });
  });
});
