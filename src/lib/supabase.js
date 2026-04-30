const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin;

function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabaseAdmin;
}

async function uploadToSupabase(bucket, file, path, { upsert = false } = {}) {
  const { error } = await getSupabaseAdmin().storage
    .from(bucket)
    .upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert,
    });

  if (error) {
    throw error;
  }

  const { data } = getSupabaseAdmin().storage
    .from(bucket)
    .getPublicUrl(path);
  return data.publicUrl;
}

module.exports = {
  getSupabaseAdmin,
  uploadToSupabase,
};
