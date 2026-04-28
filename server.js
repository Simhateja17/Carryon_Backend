require('dotenv').config();
const net = require('net');
const http = require('http');
const app = require('./src/app');
const { attachLiveTracking } = require('./src/services/liveTracking');
const { startWebhookRetryLoop } = require('./src/services/webhookInbox');

const DISCOVERY_PORT = 4999;

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, '0.0.0.0', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => findAvailablePort(startPort + 1).then(resolve).catch(reject));
  });
}

function startDiscoveryServer(actualPort) {
  const discovery = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ port: actualPort, baseUrl: `http://10.0.2.2:${actualPort}` }));
  });
  discovery.listen(DISCOVERY_PORT, '0.0.0.0', () => {
    console.log(`[discovery] Service discovery running on port ${DISCOVERY_PORT}`);
  });
  discovery.on('error', () => {
    console.warn(`[discovery] Port ${DISCOVERY_PORT} busy — discovery server not started`);
  });
}

const preferredPort = process.env.PORT || 3000;

findAvailablePort(Number(preferredPort)).then(PORT => {
  const server = http.createServer(app);
  attachLiveTracking(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CarryOn backend running on port ${PORT}`);
    startDiscoveryServer(PORT);
    startWebhookRetryLoop();
  });
});
