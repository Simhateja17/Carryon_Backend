const {
  buildAuditSummary,
  isAdminAuthUser,
  normalizeAuthUser,
  sanitizeAdminSecuritySettings,
} = require('../adminUsers');

describe('adminUsers', () => {
  test('keeps only Supabase auth users with admin metadata', () => {
    expect(isAdminAuthUser({ app_metadata: { role: 'admin' } })).toBe(true);
    expect(isAdminAuthUser({ app_metadata: { admin: true } })).toBe(true);
    expect(isAdminAuthUser({ app_metadata: { role: 'customer' } })).toBe(false);
    expect(isAdminAuthUser({ app_metadata: { role: 'not_admin' } })).toBe(false);
  });

  test('normalizes auth users for the admin directory without exposing metadata blobs', () => {
    const user = normalizeAuthUser({
      id: 'user-1',
      email: 'admin@example.com',
      app_metadata: { role: 'super_admin', internalClaim: 'hidden' },
      user_metadata: { full_name: 'Ops Admin' },
      created_at: '2026-05-01T00:00:00.000Z',
      last_sign_in_at: '2026-05-16T00:00:00.000Z',
      email_confirmed_at: '2026-05-01T00:00:00.000Z',
    });

    expect(user).toEqual({
      id: 'user-1',
      name: 'Ops Admin',
      email: 'admin@example.com',
      role: 'SUPER ADMIN',
      roleKey: 'super_admin',
      health: 'Active',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastSignInAt: '2026-05-16T00:00:00.000Z',
      emailConfirmedAt: '2026-05-01T00:00:00.000Z',
    });
  });

  test('sanitizes security settings to supported booleans', () => {
    expect(sanitizeAdminSecuritySettings({
      twoFactorRequired: false,
      loginAlertsEnabled: 0,
      suspiciousActivityDetectionEnabled: true,
      ipRestrictedAccessEnabled: 'yes',
      extra: true,
    })).toEqual({
      twoFactorRequired: false,
      loginAlertsEnabled: true,
      suspiciousActivityDetectionEnabled: true,
      ipRestrictedAccessEnabled: false,
    });
  });

  test('builds audit summary from persisted audit actions', () => {
    expect(buildAuditSummary([
      { action: 'BOOKING_CANCELLED', entityType: 'Booking' },
      { action: 'ADMIN_SECURITY_SETTINGS_UPDATED', entityType: 'AdminSetting' },
      { action: 'BLOCKED_LOGIN', entityType: 'Auth' },
      { action: 'PASSWORD_RESET', entityType: 'AdminUser' },
    ])).toEqual({
      ordersAdjusted: 1,
      permissionsChanged: 2,
      securityEvents: 2,
      credentialsReset: 1,
    });
  });
});
