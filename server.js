require('dotenv').config();
const net = require('net');
const http = require('http');
const app = require('./src/app');
const { attachLiveTracking } = require('./src/services/liveTracking');
const { startWebhookRetryLoop } = require('./src/services/webhookInbox');
const { startDriverPayoutReconciliationLoop } = require('./src/services/driverPayoutReconciliation');
const { validateSupabaseConnection } = require('./src/lib/supabase');

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

async function start() {
  // Validate Supabase connectivity before accepting requests.
  // A failure here means SUPABASE_SERVICE_KEY is misconfigured on this server.
  try {
    await validateSupabaseConnection();
    console.log('[supabase] Storage connection validated');
  } catch (err) {
    console.error('[supabase] STARTUP VALIDATION FAILED:', err.message);
    console.error('[supabase] Ensure SUPABASE_SERVICE_KEY is set to the service_role key on this server.');
    // Do not exit — the rest of the API can still work; only storage uploads will fail.
    // Change to process.exit(1) if you want a hard stop.
  }

  const PORT = await findAvailablePort(Number(preferredPort));
  const server = http.createServer(app);
  attachLiveTracking(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CarryOn backend running on port ${PORT}`);
    startDiscoveryServer(PORT);
    startWebhookRetryLoop();
    startDriverPayoutReconciliationLoop();
  });
}

start();
