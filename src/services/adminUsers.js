const prisma = require('../lib/prisma');
const { getSupabaseAdmin } = require('../lib/supabase');

const ADMIN_SECURITY_SETTINGS_KEY = 'adminSecuritySettings';

const DEFAULT_ADMIN_SECURITY_SETTINGS = {
  twoFactorRequired: true,
  loginAlertsEnabled: true,
  suspiciousActivityDetectionEnabled: false,
  ipRestrictedAccessEnabled: false,
};

const ADMIN_ROLE_NAMES = new Set([
  'admin',
  'super_admin',
  'super admin',
  'manager',
  'ops_manager',
  'operations_manager',
  'support_agent',
]);

function sanitizeAdminSecuritySettings(input = {}) {
  return {
    twoFactorRequired: input.twoFactorRequired !== false,
    loginAlertsEnabled: input.loginAlertsEnabled !== false,
    suspiciousActivityDetectionEnabled: input.suspiciousActivityDetectionEnabled === true,
    ipRestrictedAccessEnabled: input.ipRestrictedAccessEnabled === true,
  };
}

function roleFromMetadata(metadata = {}) {
  const rawRole = metadata.role || metadata.admin_role || metadata.adminRole || metadata.user_role;
  if (rawRole) return String(rawRole).trim().toLowerCase();
  if (metadata.admin === true || metadata.isAdmin === true) return 'admin';
  return '';
}

function isAdminAuthUser(user) {
  const role = roleFromMetadata(user?.app_metadata || {});
  return ADMIN_ROLE_NAMES.has(role);
}

function displayRole(role) {
  if (!role) return 'ADMIN';
  return role.replace(/[_-]+/g, ' ').trim().toUpperCase();
}

function displayName(user) {
  const metadata = user?.user_metadata || {};
  return String(
    metadata.name ||
    metadata.full_name ||
    metadata.display_name ||
    user?.email ||
    'Admin user'
  ).trim();
}

function healthForUser(user) {
  if (user?.banned_until && new Date(user.banned_until).getTime() > Date.now()) {
    return 'Suspended';
  }
  if (!user?.email_confirmed_at && !user?.confirmed_at) return 'Pending';
  return 'Active';
}

function normalizeAuthUser(user) {
  const role = roleFromMetadata(user.app_metadata || {});
  return {
    id: user.id,
    name: displayName(user),
    email: user.email || '',
    role: displayRole(role),
    roleKey: role || 'admin',
    health: healthForUser(user),
    createdAt: user.created_at || null,
    lastSignInAt: user.last_sign_in_at || null,
    emailConfirmedAt: user.email_confirmed_at || user.confirmed_at || null,
  };
}

async function listAuthUsers(client = getSupabaseAdmin()) {
  const admins = [];
  let page = 1;
  const perPage = 100;

  while (page <= 10) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Unable to list admin users: ${error.message}`);
    const users = data?.users || [];
    admins.push(...users.filter(isAdminAuthUser).map(normalizeAuthUser));
    if (users.length < perPage) break;
    page += 1;
  }

  return admins.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function roleStats(users) {
  const counts = new Map();
  for (const user of users) {
    counts.set(user.role, (counts.get(user.role) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value }));
}

function actionDetail(log) {
  const entity = log.entityId ? `#${String(log.entityId).slice(0, 8)}` : '';
  return [log.action, entity].filter(Boolean).join(' ');
}

function normalizeAuditLog(log, usersById = new Map()) {
  const actor = usersById.get(log.actorId);
  return {
    id: log.id,
    createdAt: log.createdAt,
    admin: actor?.name || actor?.email || log.actorId,
    actorId: log.actorId,
    module: log.entityType,
    action: log.action,
    detail: actionDetail(log),
    entityId: log.entityId,
  };
}

function buildAuditSummary(rows) {
  const summary = {
    ordersAdjusted: 0,
    permissionsChanged: 0,
    securityEvents: 0,
    credentialsReset: 0,
  };

  for (const row of rows) {
    const action = String(row.action || '').toUpperCase();
    const entityType = String(row.entityType || '').toUpperCase();
    if (['ORDER', 'BOOKING'].includes(entityType)) summary.ordersAdjusted += 1;
    if (
      ['ADMINUSER', 'ADMINROLE', 'ADMINSETTING'].includes(entityType) ||
      action.includes('ROLE') ||
      action.includes('PERMISSION') ||
      action.includes('SETTING')
    ) {
      summary.permissionsChanged += 1;
    }
    if (action.includes('SECURITY') || action.includes('SUSPICIOUS') || action.includes('BLOCK')) {
      summary.securityEvents += 1;
    }
    if (action.includes('PASSWORD') || action.includes('CREDENTIAL') || action.includes('OTP')) {
      summary.credentialsReset += 1;
    }
  }

  return summary;
}

async function getAdminUserManagementSnapshot(db = prisma, authClient = getSupabaseAdmin()) {
  const users = await listAuthUsers(authClient);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [auditRows, summaryRows, savedSecuritySettings] = await Promise.all([
    db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        actorId: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    }),
    db.auditLog.findMany({
      where: { createdAt: { gte: last24h } },
      select: { action: true, entityType: true },
      take: 500,
    }),
    db.adminSetting.findUnique({ where: { key: ADMIN_SECURITY_SETTINGS_KEY } }),
  ]);

  const securitySettings = sanitizeAdminSecuritySettings(
    savedSecuritySettings?.value || DEFAULT_ADMIN_SECURITY_SETTINGS
  );

  return {
    users,
    roleStats: roleStats(users),
    auditLogs: auditRows.map((row) => normalizeAuditLog(row, usersById)),
    auditSummary: buildAuditSummary(summaryRows),
    securitySettings,
  };
}

async function updateAdminSecuritySettings(db = prisma, input = {}, actor = {}) {
  const nextSettings = sanitizeAdminSecuritySettings(input);
  return db.$transaction(async (tx) => {
    const previous = await tx.adminSetting.findUnique({
      where: { key: ADMIN_SECURITY_SETTINGS_KEY },
    });
    const setting = await tx.adminSetting.upsert({
      where: { key: ADMIN_SECURITY_SETTINGS_KEY },
      update: { value: nextSettings },
      create: { key: ADMIN_SECURITY_SETTINGS_KEY, value: nextSettings },
    });
    await tx.auditLog.create({
      data: {
        actorId: String(actor.actorId || 'admin'),
        actorType: String(actor.actorType || 'ADMIN'),
        action: 'ADMIN_SECURITY_SETTINGS_UPDATED',
        entityType: 'AdminSetting',
        entityId: ADMIN_SECURITY_SETTINGS_KEY,
        oldValue: previous?.value || null,
        newValue: nextSettings,
      },
    });
    return setting.value;
  });
}

module.exports = {
  ADMIN_SECURITY_SETTINGS_KEY,
  DEFAULT_ADMIN_SECURITY_SETTINGS,
  sanitizeAdminSecuritySettings,
  isAdminAuthUser,
  normalizeAuthUser,
  buildAuditSummary,
  getAdminUserManagementSnapshot,
  updateAdminSecuritySettings,
};
