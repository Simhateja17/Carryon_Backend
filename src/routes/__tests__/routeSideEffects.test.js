jest.mock('../../lib/prisma', () => ({
  $transaction: jest.fn(),
  booking: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  wallet: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  walletTransaction: {
    create: jest.fn(),
  },
}));

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = {
      userId: 'user-1',
      email: 'customer@example.com',
      name: 'Customer',
      phone: '123',
    };
    next();
  },
  authenticateToken: (req, _res, next) => {
    req.user = { email: 'customer@example.com' };
    next();
  },
}));

jest.mock('../../middleware/driverAuth', () => ({
  authenticateDriver: (req, _res, next) => {
    req.driver = {
      id: 'driver-1',
      email: 'driver@example.com',
      name: 'Driver',
      currentLatitude: 3.1,
      currentLongitude: 101.6,
      vehicle: { type: 'CAR' },
    };
    next();
  },
  requireDriver: (_req, _res, next) => next(),
}));

jest.mock('../../lib/pushNotifications', () => ({
  notifyUserBookingEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/dispatch', () => ({
  notifyNearbyDrivers: jest.fn().mockResolvedValue({}),
  getIncomingBookingsForDriver: jest.fn().mockResolvedValue([]),
}));

const prisma = require('../../lib/prisma');
const { notifyNearbyDrivers } = require('../../services/dispatch');

function bookingPayload() {
  return {
    pickupAddress: {
      address: 'Pickup',
      latitude: 3.1,
      longitude: 101.6,
      contactName: 'Sender',
      contactPhone: '111',
    },
    deliveryAddress: {
      address: 'Drop',
      latitude: 3.2,
      longitude: 101.7,
      contactName: 'Receiver',
      contactPhone: '222',
      contactEmail: 'receiver@example.com',
    },
    vehicleType: 'CAR',
    paymentMethod: 'WALLET',
    distance: 10,
    duration: 30,
  };
}

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

  const routeHandlers = routeLayer.route.stack.map((layer) => layer.handle);
  const handlers = [...middlewareHandlers, ...routeHandlers];
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

describe('Booking route side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('booking creation debits wallet with the created booking reference', async () => {
    const tx = {
      address: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'pickup-1' })
          .mockResolvedValueOnce({ id: 'drop-1' }),
      },
      booking: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'booking-1',
          orderCode: 'ORD-000001',
          userId: 'user-1',
          status: 'SEARCHING_DRIVER',
          estimatedPrice: 11.7,
          finalPrice: 11.7,
          pickupAddress: { latitude: 3.1, longitude: 101.6 },
          deliveryAddress: { latitude: 3.2, longitude: 101.7 },
        }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balance: 50 }),
        update: jest.fn().mockResolvedValue({ id: 'wallet-1', balance: 38.3 }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'wallet-txn-1' }),
        updateMany: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await invokeRoute(require('../booking.routes'), 'POST', '/', {
      method: 'POST',
      body: bookingPayload(),
    });

    expect(response.status).toBe(201);
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'PAYMENT',
          referenceId: 'booking-1',
        }),
      })
    );
    expect(tx.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(notifyNearbyDrivers).toHaveBeenCalledWith(expect.objectContaining({ id: 'booking-1' }));
  });

  test('booking quote uses backend pricing policy', async () => {
    const response = await invokeRoute(require('../booking.routes'), 'POST', '/quote', {
      body: {
        pickupAddress: { latitude: 0, longitude: 0 },
        deliveryAddress: { latitude: 0, longitude: 0 },
        vehicleType: 'CAR',
        deliveryMode: 'Regular',
        distance: 10,
        duration: 30,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual({
      estimatedPrice: 11.7,
      distance: 10,
      duration: 30,
    });
  });

  test('cancelled booking is rejected before refund logic can run', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      userId: 'user-1',
      status: 'CANCELLED',
      paymentMethod: 'WALLET',
      paymentStatus: 'COMPLETED',
      finalPrice: 25,
      estimatedPrice: 25,
    });

    const response = await invokeRoute(require('../booking.routes'), 'POST', '/:id/cancel', {
      params: { id: 'booking-1' },
      body: { reason: 'duplicate tap' },
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Cannot cancel a cancelled booking');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('first-time user cancellation refunds wallet exactly once', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      userId: 'user-1',
      status: 'SEARCHING_DRIVER',
      paymentMethod: 'WALLET',
      paymentStatus: 'COMPLETED',
      finalPrice: 25,
      estimatedPrice: 25,
    });
    prisma.booking.update
      .mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        status: 'CANCELLED',
        paymentMethod: 'WALLET',
        paymentStatus: 'COMPLETED',
        finalPrice: 25,
        estimatedPrice: 25,
      })
      .mockResolvedValueOnce({
        id: 'booking-1',
        paymentStatus: 'REFUNDED',
      });
    prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1', userId: 'user-1', balance: 10 });
    prisma.wallet.update.mockResolvedValue({ id: 'wallet-1', balance: 35 });
    prisma.walletTransaction.create.mockResolvedValue({ id: 'refund-1' });
    prisma.$transaction.mockImplementation((operations) => Promise.all(operations));

    const response = await invokeRoute(require('../booking.routes'), 'POST', '/:id/cancel', {
      params: { id: 'booking-1' },
      body: { reason: 'changed plans' },
    });

    expect(response.status).toBe(200);
    expect(prisma.wallet.update).toHaveBeenCalledTimes(1);
    expect(prisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: { balance: { increment: 25 } },
    });
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
      data: {
        walletId: 'wallet-1',
        type: 'REFUND',
        amount: 25,
        description: 'Booking cancellation refund',
        referenceId: 'booking-1',
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('Driver job route side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('driver status route rejects invalid lifecycle transitions before update', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      driverId: 'driver-1',
      status: 'SEARCHING_DRIVER',
    });

    const response = await invokeRoute(require('../driver-jobs.routes'), 'PUT', '/:id/status', {
      params: { id: 'booking-1' },
      body: { status: 'IN_TRANSIT' },
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Cannot transition from SEARCHING_DRIVER to IN_TRANSIT');
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('delivery proof is idempotent for already settled deliveries', async () => {
    const deliveredBooking = {
      id: 'booking-1',
      driverId: 'driver-1',
      status: 'DELIVERED',
      deliveredAt: new Date('2026-01-01T00:00:00.000Z'),
      deliveryOtpVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      paymentStatus: 'COMPLETED',
      deliveryProofUrl: 'https://example.com/proof.jpg',
      finalPrice: 25,
      estimatedPrice: 25,
      distance: 10,
      duration: 30,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      pickupAddress: {
        address: 'Pickup',
        label: 'Pickup',
        latitude: 3.1,
        longitude: 101.6,
      },
      deliveryAddress: {
        address: 'Drop',
        label: 'Drop',
        latitude: 3.2,
        longitude: 101.7,
        contactName: 'Receiver',
      },
      user: {
        name: 'Customer',
        email: 'customer@example.com',
        phone: '123',
      },
    };
    prisma.booking.findUnique
      .mockResolvedValueOnce(deliveredBooking)
      .mockResolvedValueOnce(deliveredBooking);

    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/proof', {
      params: { id: 'booking-1' },
      body: {
        photoUrl: 'https://example.com/proof.jpg',
        recipientName: 'Receiver',
        otpCode: '123456',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  test('first-time delivery proof settles and credits driver earning exactly once', async () => {
    const deliveryOtpSentAt = new Date();
    const inTransitBooking = {
      id: 'booking-1',
      driverId: 'driver-1',
      status: 'IN_TRANSIT',
      dispatchSource: 'ADMIN',
      deliveryOtp: '123456',
      deliveryOtpSentAt,
      finalPrice: 25,
      estimatedPrice: 25,
    };
    const deliveredBooking = {
      ...inTransitBooking,
      status: 'DELIVERED',
      deliveryOtp: '',
      deliveredAt: new Date(),
      deliveryOtpVerifiedAt: new Date(),
      paymentStatus: 'COMPLETED',
      deliveryProofUrl: 'https://example.com/proof.jpg',
      distance: 10,
      duration: 30,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      pickupAddress: {
        address: 'Pickup',
        label: 'Pickup',
        latitude: 3.1,
        longitude: 101.6,
      },
      deliveryAddress: {
        address: 'Drop',
        label: 'Drop',
        latitude: 3.2,
        longitude: 101.7,
        contactName: 'Receiver',
      },
      user: {
        name: 'Customer',
        email: 'customer@example.com',
        phone: '123',
      },
    };
    const tx = {
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(deliveredBooking),
      },
      order: {
        upsert: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
      driverWallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'driver-wallet-1', driverId: 'driver-1' }),
        update: jest.fn().mockResolvedValue({ id: 'driver-wallet-1' }),
      },
      driverWalletTransaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'earning-1' }),
      },
      driver: {
        update: jest.fn().mockResolvedValue({ id: 'driver-1' }),
      },
    };
    prisma.booking.findUnique.mockResolvedValue(inTransitBooking);
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await invokeRoute(require('../driver-jobs.routes'), 'POST', '/:id/proof', {
      params: { id: 'booking-1' },
      body: {
        photoUrl: 'https://example.com/proof.jpg',
        recipientName: 'Receiver',
        otpCode: '123456',
      },
    });

    expect(response.status).toBe(200);
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.upsert).toHaveBeenCalledTimes(1);
    expect(tx.driverWalletTransaction.create).toHaveBeenCalledTimes(1);
    expect(tx.driverWalletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: 'driver-wallet-1',
        type: 'DELIVERY_EARNING',
        jobId: 'booking-1',
      }),
    });
    expect(tx.driver.update).toHaveBeenCalledTimes(1);
  });
});
