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
  return {
    ...driver,
    nationality: enumOrNull(driver.nationality, DRIVER_NATIONALITIES),
    licenseClass: enumOrNull(driver.licenseClass, LICENSE_CLASSES),
    state: enumOrNull(driver.state, MALAYSIAN_STATES),
    workingStates: enumList(driver.workingStates, MALAYSIAN_STATES),
    vehicle: serializeDriverVehicle(driver.vehicle),
  };
}

module.exports = {
  enumOrNull,
  serializeDriver,
  serializeDriverVehicle,
};
