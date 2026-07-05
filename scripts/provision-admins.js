// ============================================================================
// provision-admins.js
//
// Grants admin-panel access by ensuring each given email exists in Supabase
// Auth with user_metadata.role = 'admin'. The panel's is_admin_email() RPC
// checks exactly that, and login is passwordless OTP (shouldCreateUser:false),
// so the user must exist AND carry the admin role.
//
// Idempotent: if the email already exists, its role is upgraded to 'admin'
// (existing metadata preserved); otherwise a new email-confirmed user is made.
//
// Usage:
//     node scripts/provision-admins.js a@x.com b@y.com ...
//   or comma/space separated:
//     node scripts/provision-admins.js "a@x.com, b@y.com"
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service role).
// ============================================================================

const { getSupabaseAdmin } = require('../src/lib/supabase');

const emails = process.argv
  .slice(2)
  .join(' ')
  .split(/[\s,]+/)
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (emails.length === 0) {
  console.error('[provision-admins] no emails given. Pass them as arguments.');
  process.exit(1);
}

async function findUserByEmail(supabase, email) {
  // supabase-js has no getUserByEmail; scan pages (admin list is small).
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const batch = data?.users ?? [];
    const hit = batch.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (batch.length < 200) return null;
    page += 1;
  }
}

async function ensureAdmin(supabase, email) {
  const existing = await findUserByEmail(supabase, email);

  if (existing) {
    const meta = { ...(existing.user_metadata || {}), role: 'admin' };
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      user_metadata: meta,
      email_confirm: true,
    });
    if (error) throw new Error(`update ${email} failed: ${error.message}`);
    return 'upgraded existing user';
  }

  const { error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { role: 'admin' },
  });
  if (error) throw new Error(`create ${email} failed: ${error.message}`);
  return 'created new admin';
}

async function main() {
  const supabase = getSupabaseAdmin();
  console.log(`[provision-admins] processing ${emails.length} email(s)`);

  let ok = 0;
  const failures = [];
  for (const email of emails) {
    try {
      const outcome = await ensureAdmin(supabase, email);
      console.log(`  ✓ ${email} — ${outcome}`);
      ok += 1;
    } catch (err) {
      console.error(`  ✗ ${email} — ${err.message}`);
      failures.push(email);
    }
  }

  console.log(`[provision-admins] ${ok}/${emails.length} admins provisioned`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[provision-admins] fatal:', err.message);
  process.exit(1);
});
