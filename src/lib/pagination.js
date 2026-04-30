const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(query = {}, options = {}) {
  const defaultPage = options.defaultPage || DEFAULT_PAGE;
  const defaultLimit = options.defaultLimit || DEFAULT_LIMIT;
  const maxLimit = options.maxLimit || MAX_LIMIT;
  const page = toPositiveInteger(query.page, defaultPage);
  const requestedLimit = toPositiveInteger(query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

module.exports = { MAX_LIMIT, parsePagination };
