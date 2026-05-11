const {
  serializeDriver,
  serializeDriverVehicle,
} = require('../driverResponse');

describe('driver response serialization', () => {
  test('normalizes empty optional enum fields to null for mobile clients', () => {
    const driver = serializeDriver({
      id: 'driver-1',
      nationality: '',
      licenseClass: '',
      state: '',
      workingStates: ['', 'KUALA_LUMPUR', 'NOT_A_STATE'],
      vehicle: {
        id: 'vehicle-1',
        ownership: '',
        insuranceCoverageType: '',
      },
    });

    expect(driver).toMatchObject({
      nationality: null,
      licenseClass: null,
      state: null,
      workingStates: ['KUALA_LUMPUR'],
      vehicle: {
        ownership: null,
        insuranceCoverageType: null,
      },
    });
  });

  test('preserves known enum values at the driver response seam', () => {
    expect(serializeDriver({
      nationality: 'MALAYSIAN',
      licenseClass: 'D',
      state: 'SELANGOR',
      workingStates: ['SELANGOR'],
    })).toMatchObject({
      nationality: 'MALAYSIAN',
      licenseClass: 'D',
      state: 'SELANGOR',
      workingStates: ['SELANGOR'],
    });
    expect(serializeDriverVehicle({
      ownership: 'OWNED',
      insuranceCoverageType: 'COMPREHENSIVE',
    })).toMatchObject({
      ownership: 'OWNED',
      insuranceCoverageType: 'COMPREHENSIVE',
    });
  });
});
