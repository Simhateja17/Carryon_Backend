const { AppError } = require('../middleware/errorHandler');

function validationDetails(error) {
  return error.issues.reduce((details, issue) => {
    const key = issue.path.join('.') || 'body';
    details[key] = issue.message;
    return details;
  }, {});
}

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const error = new AppError('Invalid request payload', 400);
  error.details = validationDetails(result.error);
  throw error;
}

module.exports = { parseBody };
