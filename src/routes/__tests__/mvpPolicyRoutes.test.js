jest.mock('../../lib/prisma', () => ({
  $transaction: jest.fn(),
  booking: {
    findUnique: jest.fn(),
  },
  bookingExtraCharge: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  driverSupportTicket: {
    create: jest.fn(),
  },
  driverNotification: {
    create: jest.fn(),
  },
}));

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { userId: 'user-1', email: 'customer@example.com', name: 'Customer' };
    next();
  },
}));

jest.mock('../../middleware/driverAuth', () => ({
  authenticateDriver: (req, _res, next) => {
    req.driver = { id: 'driver-1', email: 'driver@example.com', name: 'Driver' };
    next();
  },
  requireDriver: (_req, _res, next) => next(),
}));

jest.mock('../../lib/pushNotifications', () => ({
  notifyUserBookingEvent: jest.fn().mockResolvedValue(undefined),
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

describe('MVP policy routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENFORCE_REGULAR_BOOKING_MODE;
  });

  test('customer cancellation after assigned grace window refunds net amount and credits driver share', async () => {
    const booking = {
      id: 'booking-1',
      userId: 'user-1',
      vehicleType: 'VAN_7FT',
      status: 'DRIVER_ASSIGNED',
      paymentMethod: 'WALLET',
      paymentStatus: 'COMPLETED',
      finalPrice: 30,
      estimatedPrice: 30,
      driverId: 'driver-1',
      driverAssignedAt: new Date(Date.now() - 4 * 60 * 1000),
    };
    const tx = {
      booking: {
        update: jest
          .fn()
          .mockResolvedValueOnce({ ...booking, status: 'CANCELLED', paymentStatus: 'REFUNDED' })
          .mockResolvedValueOnce({ ...booking, status: 'CANCELLED', paymentStatus: 'REFUNDED' }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', balance: 100 }),
        update: jest.fn().mockResolvedValue({ id: 'wallet-1' }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'wallet-tx-1' }),
      },
      driverWallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'driver-wallet-1', balance: 0 }),
        update: jest.fn().mockResolvedValue({ id: 'driver-wallet-1' }),
      },
      driverWalletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'driver-wallet-tx-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await invokeRoute(require('../booking.routes'), 'POST', '/:id/cancel', {
      params: { id: 'booking-1' },
      body: { reason: 'changed plans' },
    });

    expect(response.status).toBe(200);
    expect(tx.booking.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        cancellationFee: 5,
        cancellationDriverShare: 3.5,
        cancellationPlatformShare: 1.5,
      }),
    }));
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'REFUND', amount: 25 }),
    });
    expect(tx.driverWalletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ADJUSTMENT', amount: 3.5 }),
    });
  });

  test('driver can submit toll or parking extra charge only with proof', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      driverId: 'driver-1',
      status: 'IN_TRANSIT',
    });
    prisma.bookingExtraCharge.create.mockResolvedValue({
      id: 'charge-1',
      bookingId: 'booking-1',
      driverId: 'driver-1',
      type: 'TOLL',
      amount: 2.5,
      status: 'PENDING',
    });

    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/extra-charges', {
      params: { id: 'booking-1' },
      body: { type: 'toll', amount: 2.5, proofPath: 'extra-charge-proofs/driver-1/booking-1_1234567890.jpg' },
    });

    expect(response.status).toBe(201);
    expect(prisma.bookingExtraCharge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: 'booking-1',
        driverId: 'driver-1',
        type: 'TOLL',
        amount: 2.5,
        proofUrl: 'extra-charge-proofs/driver-1/booking-1_1234567890.jpg',
      }),
    });
  });

  test('admin approval charges customer wallet and reimburses driver', async () => {
    const charge = {
      id: 'charge-1',
      bookingId: 'booking-1',
      driverId: 'driver-1',
      type: 'PARKING',
      amount: 4,
      status: 'PENDING',
      note: '',
      booking: { id: 'booking-1', userId: 'user-1' },
    };
    const tx = {
      bookingExtraCharge: {
        update: jest.fn().mockResolvedValue({ ...charge, status: 'APPROVED' }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', balance: 100 }),
        update: jest.fn().mockResolvedValue({ id: 'wallet-1' }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'wallet-tx-1' }),
      },
      driverWallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'driver-wallet-1', balance: 0 }),
        update: jest.fn().mockResolvedValue({ id: 'driver-wallet-1' }),
      },
      driverWalletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'driver-wallet-tx-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    prisma.bookingExtraCharge.findUnique.mockResolvedValue(charge);
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await invokeRoute(require('../admin-extra-charges.routes'), 'POST', '/:id/review', {
      params: { id: 'charge-1' },
      body: { decision: 'APPROVED' },
    });

    expect(response.status).toBe(200);
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: -4, description: 'parking pass-through charge' }),
    });
    expect(tx.driverWalletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 4, description: 'parking reimbursement' }),
    });
  });

  test('driver SOS returns emergency call intent and creates urgent ticket', async () => {
    prisma.driverSupportTicket.create.mockResolvedValue({ id: 'ticket-1', priority: 'URGENT' });
    prisma.driverNotification.create.mockResolvedValue({ id: 'notification-1' });

    const response = await invokeRoute(require('../driver-support.routes'), 'POST', '/sos', {
      body: { latitude: 3.1, longitude: 101.6, accuracyMeters: 20 },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.emergencyNumber).toBe('999');
    expect(response.body.data.action).toBe('CALL_EMERGENCY_SERVICES');
    expect(prisma.driverSupportTicket.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subject: 'SOS Emergency',
        priority: 'URGENT',
      }),
    });
  });

  test('extra-charge submit rejects public URLs', async () => {
    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/extra-charges', {
      params: { id: 'booking-1' },
      body: { type: 'toll', amount: 2.5, proofPath: 'https://evil.com/fake.jpg' },
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/public url/i);
  });

  test('extra-charge submit rejects proof path for another driver', async () => {
    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/extra-charges', {
      params: { id: 'booking-1' },
      body: { type: 'toll', amount: 2.5, proofPath: 'extra-charge-proofs/driver-999/booking-1_123.jpg' },
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/must belong to your driver/i);
  });

  test('extra-charge submit accepts canonical proof path', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      driverId: 'driver-1',
      status: 'IN_TRANSIT',
    });
    prisma.bookingExtraCharge.create.mockResolvedValue({
      id: 'charge-2',
      bookingId: 'booking-1',
      driverId: 'driver-1',
      type: 'PARKING',
      amount: 5,
      status: 'PENDING',
    });

    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/extra-charges', {
      params: { id: 'booking-1' },
      body: { type: 'parking', amount: 5, proofPath: 'extra-charge-proofs/driver-1/booking-1_1234567890.jpg' },
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
  });

  test('extra-charge submit rejects old-format path without bucket prefix', async () => {
    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/extra-charges', {
      params: { id: 'booking-1' },
      body: { type: 'toll', amount: 2.5, proofPath: 'extra-charges/driver-1/booking-1_123.jpg' },
    });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/must belong to your driver/i);
  });
});
