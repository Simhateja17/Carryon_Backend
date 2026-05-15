const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin;
let supabaseStorageAdmin;

const REQUIRED_STORAGE_BUCKETS = [
  {
    name: 'package-images',
    public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  },
  {
    name: 'driver-documents',
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/pdf'],
  },
  {
    name: 'extra-charge-proofs',
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  {
    name: 'support-attachments',
    public: false,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  },
];

function serviceRoleHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    throw new Error('Supabase admin client not configured: SUPABASE_SERVICE_KEY missing');
  }
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

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
          // Service-role clients must never adopt a user session. Supabase Storage
          // authorizes by the Authorization header, not the apikey header.
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
        global: {
          headers: serviceRoleHeaders(),
        },
      }
    );
  }
  return supabaseAdmin;
}

function getSupabaseStorageAdmin() {
  if (!supabaseStorageAdmin) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Supabase storage admin client not configured: SUPABASE_URL/SUPABASE_SERVICE_KEY missing');
    }
    supabaseStorageAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
        global: {
          headers: serviceRoleHeaders(),
        },
      }
    );
  }
  return supabaseStorageAdmin;
}

function normalizeMimeTypes(values) {
  return [...new Set(values || [])].sort();
}

function bucketHasMimeTypes(bucket, required) {
  const actual = normalizeMimeTypes(bucket.allowed_mime_types || bucket.allowedMimeTypes);
  const expected = normalizeMimeTypes(required);
  return expected.every((mime) => actual.includes(mime));
}

function inspectStorageBuckets(buckets) {
  const byName = new Map((buckets || []).map((bucket) => [bucket.name || bucket.id, bucket]));
  const missingBuckets = [];
  const misconfiguredBuckets = [];

  for (const expected of REQUIRED_STORAGE_BUCKETS) {
    const bucket = byName.get(expected.name);
    if (!bucket) {
      missingBuckets.push(expected.name);
      continue;
    }

    const issues = [];
    if (bucket.public !== expected.public) {
      issues.push(`public must be ${expected.public}`);
    }
    const actualLimit = bucket.file_size_limit || bucket.fileSizeLimit;
    if (actualLimit !== expected.fileSizeLimit) {
      issues.push(`file size limit must be ${expected.fileSizeLimit}`);
    }
    if (!bucketHasMimeTypes(bucket, expected.allowedMimeTypes)) {
      issues.push('allowed MIME types are incomplete');
    }
    if (issues.length > 0) {
      misconfiguredBuckets.push({ name: expected.name, issues });
    }
  }

  return {
    bucketNames: [...byName.keys()].sort(),
    missingBuckets,
    misconfiguredBuckets,
  };
}

async function runStorageUploadProbe(client = getSupabaseStorageAdmin()) {
  const probePath = `_health/service-role-upload-${process.pid}-${Date.now()}.jpg`;
  const bucket = client.storage.from('driver-documents');
  const body = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);

  const { error: uploadError } = await bucket.upload(probePath, body, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (uploadError) {
    throw Object.assign(new Error(`Storage upload probe failed: ${uploadError.message}`), {
      cause: uploadError,
      statusCode: uploadError.statusCode || uploadError.status,
    });
  }

  const { error: deleteError } = await bucket.remove([probePath]);
  if (deleteError) {
    throw Object.assign(new Error(`Storage upload probe cleanup failed: ${deleteError.message}`), {
      cause: deleteError,
      statusCode: deleteError.statusCode || deleteError.status,
    });
  }

  return { bucket: 'driver-documents', path: probePath };
}

async function checkStorageHealth({ probe = false } = {}) {
  const client = getSupabaseStorageAdmin();
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) {
    throw new Error(
      `Supabase storage is not reachable or SUPABASE_SERVICE_KEY is wrong: ${error.message}`
    );
  }

  const inspection = inspectStorageBuckets(buckets);
  const status = inspection.missingBuckets.length === 0 && inspection.misconfiguredBuckets.length === 0
    ? 'ok'
    : 'degraded';
  const result = {
    status,
    storage: 'reachable',
    ...inspection,
  };

  if (status !== 'ok') {
    return result;
  }

  if (probe) {
    await runStorageUploadProbe(client);
    result.uploadProbe = 'ok';
  }

  return result;
}

/**
 * Validate at startup that the Supabase client is reachable and the service key is valid.
 * Call this during server initialisation (before accepting requests).
 */
async function validateSupabaseConnection() {
  const health = await checkStorageHealth({
    probe: process.env.SUPABASE_STORAGE_PROBE_ON_STARTUP !== 'false',
  });
  if (health.status !== 'ok') {
    throw new Error(`Supabase storage is misconfigured: ${JSON.stringify({
      missingBuckets: health.missingBuckets,
      misconfiguredBuckets: health.misconfiguredBuckets,
    })}`);
  }
  return health;
}

async function uploadToSupabase(bucket, file, path, { upsert = true } = {}) {
  const { error } = await getSupabaseStorageAdmin().storage
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
function parseStorageObjectRef(objectRef) {
  const raw = String(objectRef || '').trim();
  if (!raw) throw new Error('Invalid object path');

  let objectPath = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      throw new Error('Invalid object URL');
    }

    const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error('Unsupported storage object URL');
    }
    objectPath = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  }

  const slashIndex = objectPath.indexOf('/');
  if (slashIndex === -1) throw new Error('Invalid object path');
  return {
    bucket: objectPath.substring(0, slashIndex),
    path: objectPath.substring(slashIndex + 1),
  };
}

async function getSignedUrl(objectPath, expiresIn = 3600) {
  const { bucket, path } = parseStorageObjectRef(objectPath);

  const { data, error } = await getSupabaseStorageAdmin().storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  REQUIRED_STORAGE_BUCKETS,
  bucketHasMimeTypes,
  checkStorageHealth,
  getSupabaseAdmin,
  getSupabaseStorageAdmin,
  inspectStorageBuckets,
  runStorageUploadProbe,
  serviceRoleHeaders,
  validateSupabaseConnection,
  uploadToSupabase,
  getSignedUrl,
  parseStorageObjectRef,
};
