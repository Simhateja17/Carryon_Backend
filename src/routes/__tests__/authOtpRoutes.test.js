process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  wallet: {
    create: jest.fn(),
  },
};

const mockSignInWithOtp = jest.fn();
const mockVerifyOtp = jest.fn();

jest.mock('../../lib/prisma', () => mockPrisma);
jest.mock('../../lib/supabase', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
      verifyOtp: mockVerifyOtp,
    },
  })),
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      refreshSession: jest.fn(),
    },
  })),
}));
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (_req, _res, next) => next(),
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

describe('customer OTP auth routes', () => {
  const existingUser = {
    id: 'user-1',
    email: 'phone-60123456789@phone.carryon.local',
    name: 'Existing User',
    phone: '+60 12-345 6789',
    isVerified: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([existingUser]);
    mockPrisma.user.findUnique.mockResolvedValue(existingUser);
    mockPrisma.user.update.mockResolvedValue({
      ...existingUser,
      phone: '+60123456789',
    });
    mockSignInWithOtp.mockResolvedValue({ error: null });
    mockVerifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        },
      },
      error: null,
    });
  });

  test('signup send-otp still sends OTP when phone already belongs to an account', async () => {
    const response = await invokeRoute(require('../auth.routes'), 'POST', '/send-otp', {
      body: { mode: 'signup', phone: '+60123456789' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true });
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      options: {
        shouldCreateUser: true,
        channel: 'sms',
      },
    });
  });

  test('signup verify-otp logs in existing phone account instead of creating a duplicate user', async () => {
    const response = await invokeRoute(require('../auth.routes'), 'POST', '/verify-otp', {
      body: { mode: 'signup', phone: '+60123456789', otp: '123456', name: 'New Name' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      token: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      isNewUser: false,
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { email: existingUser.email },
      data: {
        isVerified: true,
        phone: '+60123456789',
      },
    });
  });
});
