function legacyApiHeaders(req, res, next) {
  res.set('Deprecation', 'true');
  res.set('Sunset', '2026-12-31');
  res.set('Link', '</api/v1>; rel="successor-version"');
  next();
}

function mountVersionedRoute(app, path, router, ...middleware) {
  app.use(`/api/v1${path}`, ...middleware, router);
  app.use(`/api${path}`, legacyApiHeaders, ...middleware, router);
}

function mountVersionedMiddleware(app, path, middleware) {
  app.use(`/api/v1${path}`, middleware);
  app.use(`/api${path}`, legacyApiHeaders, middleware);
}

module.exports = {
  legacyApiHeaders,
  mountVersionedRoute,
  mountVersionedMiddleware,
};
