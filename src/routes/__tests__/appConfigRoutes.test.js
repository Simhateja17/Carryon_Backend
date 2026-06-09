const express = require('express');
const router = require('../app-config.routes');

function request(app, path) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: path, originalUrl: path, headers: {}, connection: {} };
    const res = {
      headers: {},
      statusCode: 200,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      getHeader(key) { return this.headers[key.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      end(body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); },
      json(body) {
        this.setHeader('Content-Type', 'application/json');
        this.end(JSON.stringify(body));
      },
    };
    app.handle(req, res);
  });
}

describe('app config routes', () => {
  const app = express().use('/app-config', router);

  test('returns the safe current-version default', async () => {
    const response = await request(app, '/app-config/minimum-version?app=carryon&platform=android');

    expect(response.status).toBe(200);
    expect(response.body.data.minimumVersion).toBe('1.0.2');
    expect(response.body.data.storeUrl).toContain('com.company.carryon_malaysia');
  });

  test('rejects unknown apps and platforms', async () => {
    const response = await request(app, '/app-config/minimum-version?app=unknown&platform=android');

    expect(response.status).toBe(400);
  });
});
