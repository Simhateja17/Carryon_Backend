#!/usr/bin/env node
/**
 * setup-storage-buckets.js
 *
 * Creates required Supabase storage buckets and sets their public/private config.
 * Run once after deploying to a new environment:
 *   node scripts/setup-storage-buckets.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BUCKETS = [
  {
    name: 'package-images',
    public: true,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  },
  {
    name: 'driver-documents',
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/pdf'],
  },
];

async function setupBuckets() {
  const { data: existing, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.error('Failed to list buckets:', listError.message);
    process.exit(1);
  }

  const existingNames = new Set((existing || []).map((b) => b.name));

  for (const bucket of BUCKETS) {
    if (existingNames.has(bucket.name)) {
      console.log(`[skip] Bucket already exists: ${bucket.name}`);

      // Update config in case it drifted
      const { error: updateError } = await supabase.storage.updateBucket(bucket.name, {
        public: bucket.public,
        fileSizeLimit: bucket.fileSizeLimit,
        allowedMimeTypes: bucket.allowedMimeTypes,
      });
      if (updateError) {
        console.warn(`[warn] Could not update bucket "${bucket.name}": ${updateError.message}`);
      } else {
        console.log(`[ok]   Updated config for: ${bucket.name}`);
      }
      continue;
    }

    const { error: createError } = await supabase.storage.createBucket(bucket.name, {
      public: bucket.public,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: bucket.allowedMimeTypes,
    });

    if (createError) {
      console.error(`[fail] Could not create bucket "${bucket.name}": ${createError.message}`);
    } else {
      console.log(`[ok]   Created bucket: ${bucket.name} (public=${bucket.public})`);
    }
  }

  console.log('\nDone. Run this script whenever you set up a new environment.');
}

setupBuckets().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
