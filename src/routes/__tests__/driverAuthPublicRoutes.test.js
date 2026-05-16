process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'test-firebase-credentials.json';

jest.mock('../../lib/firebase', () => ({}));

const mockAuthenticateDriver = jest.fn((_req, _res, next) => {
  const { AppError } = require('../../middleware/errorHandler');
  next(new AppError('Authentication required', 401));
});

jest.mock('../../middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(new Error('customer auth should not be reached')),
  authenticateToken: (_req, _res, next) => next(new Error('customer token auth should not be reached')),
  resolveAuthenticatedUserFromToken: jest.fn(),
}));

jest.mock('../../middleware/driverAuth', () => ({
  authenticateDriver: mockAuthenticateDriver,
  requireDriver: (_req, _res, next) => next(),
}));

jest.mock('../../lib/prisma', () => ({
  $queryRaw: jest.fn(),
  driver: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  driverWallet: {
    create: jest.fn(),
  },
}));

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
  for (const handlerLayer of routeLayer.route.stack) {
    if (capturedError || responseBody !== undefined) break;
    const handler = handlerLayer.handle;
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

describe('driver auth public route mounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('send-otp is public and does not require Authorization', async () => {
    const response = await invokeRoute(require('../driver-auth.routes'), 'POST', '/send-otp', {
      body: { email: 'not-an-email', mode: 'login' },
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('A valid email address is required.');
    expect(mockAuthenticateDriver).not.toHaveBeenCalled();
  });

  test('sync stays protected by driver authentication', async () => {
    const response = await invokeRoute(require('../driver-auth.routes'), 'POST', '/sync', {
      body: {},
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Authentication required');
    expect(mockAuthenticateDriver).toHaveBeenCalledTimes(1);
  });

  test('driver auth module is mounted before the generic driver module', () => {
    const app = require('../../app');
    const stack = app._router.stack;
    const driverAuthIndex = stack.findIndex((layer) => String(layer.regexp).includes('driver\\/auth'));
    const genericDriverIndex = stack.findIndex((layer) => String(layer.regexp).includes('driver\\/?(?=\\/|$)'));

    expect(driverAuthIndex).toBeGreaterThanOrEqual(0);
    expect(genericDriverIndex).toBeGreaterThanOrEqual(0);
    expect(driverAuthIndex).toBeLessThan(genericDriverIndex);
  });
});
