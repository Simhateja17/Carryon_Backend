const DRIVER_NATIONALITIES = new Set(['MALAYSIAN', 'FOREIGNER']);
const LICENSE_CLASSES = new Set(['B', 'B1', 'B2', 'D', 'DA', 'E', 'E1', 'E2', 'GDL']);
const MALAYSIAN_STATES = new Set([
  'JOHOR',
  'KEDAH',
  'KELANTAN',
  'MELAKA',
  'NEGERI_SEMBILAN',
  'PAHANG',
  'PENANG',
  'PERAK',
  'PERLIS',
  'SABAH',
  'SARAWAK',
  'SELANGOR',
  'TERENGGANU',
  'KUALA_LUMPUR',
  'LABUAN',
  'PUTRAJAYA',
]);
const VEHICLE_OWNERSHIPS = new Set(['OWNED', 'LEASED', 'COMPANY_PROVIDED']);
const INSURANCE_COVERAGE_TYPES = new Set(['COMPREHENSIVE', 'THIRD_PARTY', 'THIRD_PARTY_FIRE_THEFT']);
const { getSignedUrl } = require('./supabase');

function enumOrNull(value, allowed) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return allowed.has(normalized) ? normalized : null;
}

function enumList(value, allowed) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => enumOrNull(entry, allowed))
    .filter(Boolean);
}

function serializeDriverVehicle(vehicle) {
  if (!vehicle) return null;
  return {
    ...vehicle,
    ownership: enumOrNull(vehicle.ownership, VEHICLE_OWNERSHIPS),
    insuranceCoverageType: enumOrNull(vehicle.insuranceCoverageType, INSURANCE_COVERAGE_TYPES),
  };
}

function serializeDriver(driver) {
  if (!driver) return null;
  const hasBankDetails = !!(
    String(driver.bankName || '').trim() &&
    String(driver.bankAccountHolder || '').trim() &&
    String(driver.bankAccountNumber || '').trim()
  );
  const bankPayoutsEnabled = hasBankDetails && driver.bankDetailsStatus === 'APPROVED';
  return {
    ...driver,
    stripeDetailsSubmitted: hasBankDetails,
    stripePayoutsEnabled: bankPayoutsEnabled,
    nationality: enumOrNull(driver.nationality, DRIVER_NATIONALITIES),
    licenseClass: enumOrNull(driver.licenseClass, LICENSE_CLASSES),
    state: enumOrNull(driver.state, MALAYSIAN_STATES),
    workingStates: enumList(driver.workingStates, MALAYSIAN_STATES),
    vehicle: serializeDriverVehicle(driver.vehicle),
  };
}

async function serializeDriverWithMedia(driver) {
  const serialized = serializeDriver(driver);
  if (!serialized) return null;

  let photoUrl = null;
  if (serialized.photo) {
    try {
      photoUrl = await getSignedUrl(serialized.photo, 3600);
    } catch (error) {
      console.error('[driver-response] failed to sign driver photo:', error.message);
    }
  }

  return {
    ...serialized,
    photoUrl,
  };
}

module.exports = {
  enumOrNull,
  serializeDriver,
  serializeDriverWithMedia,
  serializeDriverVehicle,
};
