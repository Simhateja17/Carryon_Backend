// ============================================================================
// purge-supabase-auth.js
//
// Frees every Supabase identity + stored file so users/drivers sign up fresh:
//   1. Empties the storage buckets (driver docs, package images, proofs, etc.)
//   2. Deletes ALL Supabase Auth identities (auth.users)
//
// Run this ALONGSIDE scripts/reset-for-launch.sql (which clears the Postgres
// app data). The DB rows that point at these files/identities are wiped by the
// SQL script; this script removes the files and identities themselves.
//
// DESTRUCTIVE and IRREVERSIBLE. Take a backup first.
//
// Safety: requires an explicit confirmation flag so it can't run by accident.
//     Dry run (counts only, deletes nothing):
//         node scripts/purge-supabase-auth.js
//     Actually delete:
//         node scripts/purge-supabase-auth.js --confirm
//
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service role).
// ============================================================================

const {
  getSupabaseAdmin,
  getSupabaseStorageAdmin,
  REQUIRED_STORAGE_BUCKETS,
} = require('../src/lib/supabase');

const CONFIRMED = process.argv.includes('--confirm');
const AUTH_PAGE_SIZE = 200;
const LIST_PAGE_SIZE = 100;

// ---- Storage --------------------------------------------------------------

// Recursively collect every object path under `prefix` in a bucket. Supabase
// `.list()` returns folders (entries whose `id` is null) and files, paginated.
async function collectObjectPaths(storage, bucket, prefix = '') {
  const paths = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await storage.storage
      .from(bucket)
      .list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) throw new Error(`list ${bucket}/${prefix} failed: ${error.message}`);
    const entries = data ?? [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // Folder — recurse into it.
        const nested = await collectObjectPaths(storage, bucket, full);
        paths.push(...nested);
      } else {
        paths.push(full);
      }
    }

    if (entries.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return paths;
}

async function emptyBuckets() {
  const storage = getSupabaseStorageAdmin();
  const bucketNames = (REQUIRED_STORAGE_BUCKETS || []).map((b) => b.name);
  let totalObjects = 0;

  for (const bucket of bucketNames) {
    const paths = await collectObjectPaths(storage, bucket);
    totalObjects += paths.length;
    console.log(`[purge] bucket ${bucket}: ${paths.length} objects`);

    if (!CONFIRMED || paths.length === 0) continue;

    // Remove in chunks; the storage API caps how many paths per request.
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { error } = await storage.storage.from(bucket).remove(chunk);
      if (error) throw new Error(`remove from ${bucket} failed: ${error.message}`);
    }
    console.log(`[purge] bucket ${bucket}: removed ${paths.length} objects`);
  }
  return totalObjects;
}

// ---- Auth -----------------------------------------------------------------

async function purgeAuthUsers() {
  const supabase = getSupabaseAdmin();

  // Collect every auth user across all pages first, so pagination isn't
  // disturbed by deletions happening underneath us.
  const userIds = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`);
    const batch = data?.users ?? [];
    if (batch.length === 0) break;
    for (const u of batch) userIds.push(u.id);
    if (batch.length < AUTH_PAGE_SIZE) break;
    page += 1;
  }

  console.log(`[purge] found ${userIds.length} auth users`);
  if (!CONFIRMED) return userIds.length;

  let deleted = 0;
  const failures = [];
  for (const id of userIds) {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) failures.push({ id, message: error.message });
    else deleted += 1;
  }

  console.log(`[purge] deleted ${deleted}/${userIds.length} auth users`);
  if (failures.length) {
    console.error(`[purge] ${failures.length} auth deletion failures:`);
    for (const f of failures) console.error(`  ${f.id}: ${f.message}`);
    process.exitCode = 1;
  }
  return deleted;
}

// ---- Main -----------------------------------------------------------------

async function main() {
  // Empty buckets BEFORE deleting auth users — file paths are keyed by user id,
  // so purge storage while we can still make sense of it.
  const objectCount = await emptyBuckets();
  const userCount = await purgeAuthUsers();

  if (!CONFIRMED) {
    console.log(
      `[purge] DRY RUN — nothing deleted. Would remove ${objectCount} storage objects ` +
      `and ${userCount} auth users. Re-run with --confirm.`
    );
  } else {
    console.log('[purge] complete.');
  }
}

main().catch((err) => {
  console.error('[purge] fatal:', err.message);
  process.exit(1);
});
