const express = require('express');
const {
  legacyApiHeaders,
  mountVersionedRoute,
} = require('../mountApiRoutes');

function request(app, path) {
  return new Promise((resolve) => {
    const req = {
      method: 'GET',
      url: path,
      originalUrl: path,
      headers: {},
      connection: {},
    };
    const res = {
      headers: {},
      statusCode: 200,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      getHeader(key) { return this.headers[key.toLowerCase()]; },
      set(key, value) { this.setHeader(key, value); return this; },
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
      json(body) {
        this.setHeader('Content-Type', 'application/json');
        this.end(JSON.stringify(body));
      },
    };
    app.handle(req, res);
  });
}

describe('versioned route mounting', () => {
  test('mounts canonical v1 and legacy routes with deprecation headers', async () => {
    const app = express();
    const router = express.Router();
    router.get('/ping', (_req, res) => res.json({ ok: true }));
    mountVersionedRoute(app, '/demo', router);

    const v1 = await request(app, '/api/v1/demo/ping');
    const legacy = await request(app, '/api/demo/ping');

    expect(v1.body).toBe(JSON.stringify({ ok: true }));
    expect(v1.headers.deprecation).toBeUndefined();
    expect(legacy.body).toBe(JSON.stringify({ ok: true }));
    expect(legacy.headers.deprecation).toBe('true');
  });

  test('legacy header middleware points to successor version', async () => {
    const req = {};
    const res = { set: jest.fn() };
    const next = jest.fn();

    legacyApiHeaders(req, res, next);

    expect(res.set).toHaveBeenCalledWith('Link', '</api/v1>; rel="successor-version"');
    expect(next).toHaveBeenCalled();
  });
});
