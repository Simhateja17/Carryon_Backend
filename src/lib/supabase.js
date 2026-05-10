const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin;

function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Supabase admin client not configured: SUPABASE_URL/SUPABASE_SERVICE_KEY missing');
    }
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          // Disable auto-refresh — service role tokens don't expire the same way
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return supabaseAdmin;
}

/**
 * Validate at startup that the Supabase client is reachable and the service key is valid.
 * Call this during server initialisation (before accepting requests).
 */
async function validateSupabaseConnection() {
  const client = getSupabaseAdmin();
  const { error } = await client.storage.listBuckets();
  if (error) {
    throw new Error(
      `Supabase storage is not reachable or SUPABASE_SERVICE_KEY is wrong: ${error.message}`
    );
  }
}

async function uploadToSupabase(bucket, file, path, { upsert = true } = {}) {
  const { error } = await getSupabaseAdmin().storage
    .from(bucket)
    .upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert,
    });

  if (error) {
    // Provide a clearer message for the most common misconfiguration
    if (error.statusCode === 403 || error.message?.includes('row-level security')) {
      throw Object.assign(error, {
        message:
          'Storage upload blocked — check that SUPABASE_SERVICE_KEY is the service_role key ' +
          '(not the anon key) and that the bucket exists. Original: ' + error.message,
      });
    }
    throw error;
  }

  // Store the object path, not a public URL
  return `${bucket}/${path}`;
}

/**
 * Generate a short-lived signed URL for viewing a stored object.
 * @param {string} objectPath - "bucket/path/to/file" as returned by uploadToSupabase
 * @param {number} expiresIn - seconds until URL expires (default 1 hour)
 */
async function getSignedUrl(objectPath, expiresIn = 3600) {
  const slashIndex = objectPath.indexOf('/');
  if (slashIndex === -1) throw new Error('Invalid object path');
  const bucket = objectPath.substring(0, slashIndex);
  const path = objectPath.substring(slashIndex + 1);

  const { data, error } = await getSupabaseAdmin().storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  getSupabaseAdmin,
  validateSupabaseConnection,
  uploadToSupabase,
  getSignedUrl,
};
