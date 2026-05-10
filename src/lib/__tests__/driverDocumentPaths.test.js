const {
  allowedDriverDocumentPrefixes,
  isDriverDocumentPathForDriver,
} = require('../driverDocumentPaths');

describe('driverDocumentPaths', () => {
  test('accepts canonical mobile storage paths for the authenticated driver', () => {
    expect(
      isDriverDocumentPathForDriver(
        'driver-documents/driver-123/MYKAD_FRONT_1778400603816.jpg',
        'driver-123'
      )
    ).toBe(true);
  });

  test('accepts legacy drivers folder paths for rollout compatibility', () => {
    expect(
      isDriverDocumentPathForDriver(
        'driver-documents/drivers/driver-123/SELFIE_1778400953808.jpg',
        'driver-123'
      )
    ).toBe(true);
  });

  test('rejects paths belonging to another driver', () => {
    expect(
      isDriverDocumentPathForDriver(
        'driver-documents/other-driver/MYKAD_FRONT_1778400603816.jpg',
        'driver-123'
      )
    ).toBe(false);
    expect(
      isDriverDocumentPathForDriver(
        'driver-documents/drivers/other-driver/MYKAD_FRONT_1778400603816.jpg',
        'driver-123'
      )
    ).toBe(false);
  });

  test('documents every accepted owner prefix shape', () => {
    expect(allowedDriverDocumentPrefixes('driver-123')).toEqual([
      'driver-documents/driver-123/',
      'driver-documents/drivers/driver-123/',
    ]);
  });
});
