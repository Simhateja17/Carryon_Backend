#!/usr/bin/env node
/**
 * Normalizes DriverDocument.imageUrl values into private object paths.
 *
 * Dry-run by default:
 *   node scripts/normalize-driver-documents.js
 *
 * Apply changes:
 *   node scripts/normalize-driver-documents.js --apply
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { getSupabaseAdmin } = require('../src/lib/supabase');

const BUCKET = 'driver-documents';
const PUBLIC_PREFIX = `/storage/v1/object/public/${BUCKET}/`;
const apply = process.argv.includes('--apply');

function parseStorageName(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (imageUrl.startsWith(`${BUCKET}/`)) return imageUrl.slice(BUCKET.length + 1);

  try {
    const parsed = new URL(imageUrl);
    const index = parsed.pathname.indexOf(PUBLIC_PREFIX);
    if (index === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(index + PUBLIC_PREFIX.length));
  } catch (_error) {
    return null;
  }
}

function canonicalName(driverId, name) {
  const parts = name.split('/');
  const fileName = parts[parts.length - 1];
  return `${driverId}/${fileName}`;
}

async function ownerDriverForName(name) {
  const parts = name.split('/');
  if (parts[0] !== 'drivers' || !parts[1]) return null;
  const authUser = await prisma.$queryRaw`
    SELECT u.email
    FROM auth.users u
    WHERE u.id::text = ${parts[1]}
    LIMIT 1
  `;
  const email = authUser?.[0]?.email;
  if (!email) return null;
  return prisma.driver.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
}

async function normalizeDocument(doc) {
  const name = parseStorageName(doc.imageUrl);
  if (!name) return { action: 'skip', reason: 'not a Supabase driver document URL/path' };

  if (name.startsWith(`${doc.driverId}/`)) {
    const normalized = `${BUCKET}/${name}`;
    if (normalized === doc.imageUrl) return { action: 'skip', reason: 'already canonical' };
    if (apply) {
      await prisma.driverDocument.update({ where: { id: doc.id }, data: { imageUrl: normalized } });
    }
    return { action: apply ? 'updated' : 'would-update', imageUrl: normalized };
  }

  const ownerDriver = await ownerDriverForName(name);
  if (!ownerDriver || ownerDriver.id !== doc.driverId) {
    return { action: 'flag', reason: 'legacy object owner does not match DriverDocument.driverId' };
  }

  const nextName = canonicalName(doc.driverId, name);
  const nextPath = `${BUCKET}/${nextName}`;

  if (apply) {
    const supabase = getSupabaseAdmin();
    const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(name);
    if (downloadError) throw downloadError;
    const bytes = Buffer.from(await data.arrayBuffer());
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(nextName, bytes, { upsert: true });
    if (uploadError) throw uploadError;
    await prisma.driverDocument.update({ where: { id: doc.id }, data: { imageUrl: nextPath } });
  }

  return { action: apply ? 'copied-and-updated' : 'would-copy-and-update', imageUrl: nextPath };
}

async function main() {
  const documents = await prisma.driverDocument.findMany({ orderBy: { uploadedAt: 'desc' } });
  const counts = {};

  for (const doc of documents) {
    const result = await normalizeDocument(doc);
    counts[result.action] = (counts[result.action] || 0) + 1;
    if (result.action !== 'skip') {
      console.log(JSON.stringify({
        documentId: doc.id,
        driverId: doc.driverId,
        type: doc.type,
        ...result,
      }));
    }
  }

  console.log(JSON.stringify({ apply, counts }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
