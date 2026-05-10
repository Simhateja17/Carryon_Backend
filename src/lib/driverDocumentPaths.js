function allowedDriverDocumentPrefixes(driverId) {
  return [
    `driver-documents/${driverId}/`,
    `driver-documents/drivers/${driverId}/`,
  ];
}

function isDriverDocumentPathForDriver(rawPath, driverId) {
  if (typeof rawPath !== 'string' || typeof driverId !== 'string' || !driverId) {
    return false;
  }
  return allowedDriverDocumentPrefixes(driverId).some((prefix) => rawPath.startsWith(prefix));
}

module.exports = {
  allowedDriverDocumentPrefixes,
  isDriverDocumentPathForDriver,
};
