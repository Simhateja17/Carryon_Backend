const REQUIRED_DRIVER_ONBOARDING_DOCUMENT_TYPES = Object.freeze([
  'MYKAD_FRONT',
  'MYKAD_BACK',
  'SELFIE',
  'DRIVERS_LICENSE',
  'DRIVERS_LICENSE_BACK',
  'VEHICLE_REGISTRATION',
  'VEHICLE_PHOTO_FRONT',
  'VEHICLE_PHOTO_BACK',
]);

const REQUIRED_DRIVER_ELIGIBILITY_DOCUMENT_TYPES = Object.freeze([
  'DRIVERS_LICENSE',
  'DRIVERS_LICENSE_BACK',
  'VEHICLE_REGISTRATION',
  'VEHICLE_PHOTO_FRONT',
  'VEHICLE_PHOTO_BACK',
]);

const MALAYSIAN_DRIVER_NATIONALITY = 'MALAYSIAN';

function documentTypesByStatus(documents = [], status) {
  return new Set(
    documents
      .filter((document) => document.status === status)
      .map((document) => document.type)
  );
}

function missingDocumentTypes(documents = [], requiredTypes = REQUIRED_DRIVER_ONBOARDING_DOCUMENT_TYPES) {
  const submitted = new Set(documents.map((document) => document.type));
  return requiredTypes.filter((type) => !submitted.has(type));
}

function missingApprovedDocumentTypes(documents = [], requiredTypes = REQUIRED_DRIVER_ELIGIBILITY_DOCUMENT_TYPES) {
  const approved = documentTypesByStatus(documents, 'APPROVED');
  return requiredTypes.filter((type) => !approved.has(type));
}

module.exports = {
  MALAYSIAN_DRIVER_NATIONALITY,
  REQUIRED_DRIVER_ELIGIBILITY_DOCUMENT_TYPES,
  REQUIRED_DRIVER_ONBOARDING_DOCUMENT_TYPES,
  missingApprovedDocumentTypes,
  missingDocumentTypes,
};
