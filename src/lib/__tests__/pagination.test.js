const { parsePagination } = require('../pagination');

describe('parsePagination', () => {
  test('defaults invalid page and limit values', () => {
    expect(parsePagination({ page: 'bad', limit: 'bad' })).toEqual({
      page: 1,
      limit: 20,
      skip: 0,
    });
  });

  test('caps requested limits at 100', () => {
    expect(parsePagination({ page: '2', limit: '999999' })).toEqual({
      page: 2,
      limit: 100,
      skip: 100,
    });
  });

  test('supports endpoint-specific default limits without raising the cap', () => {
    expect(parsePagination({}, { defaultLimit: 50 })).toEqual({
      page: 1,
      limit: 50,
      skip: 0,
    });
  });
});
