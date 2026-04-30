// ── Live Tracking Module ────────────────────────────────────
// WebSocket rooms keyed by bookingId. REST remains the fallback Adapter.

const WebSocket = require('ws');
const prisma = require('../lib/prisma');
const { resolveAuthenticatedUserFromToken } = require('../middleware/auth');

const ACTIVE_TRACKING_STATUSES = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'PICKUP_DONE', 'IN_TRANSIT', 'ARRIVED_AT_DROP'];
const rooms = new Map();
let wss = null;

function roomFor(bookingId) {
  if (!rooms.has(bookingId)) rooms.set(bookingId, new Set());
  return rooms.get(bookingId);
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

async function canUserTrackBooking(userId, bookingId) {
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      userId,
      status: { in: ACTIVE_TRACKING_STATUSES },
    },
    select: {
      id: true,
      driver: { select: { id: true, currentLatitude: true, currentLongitude: true } },
    },
  });
  return booking;
}

async function attachLiveTracking(server) {
  wss = new WebSocket.WebSocketServer({ server, path: '/api/tracking/live' });

  wss.on('connection', async (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const bookingId = url.searchParams.get('bookingId') || '';
    const token = url.searchParams.get('token') || '';
    let joinedRoom = null;

    try {
      if (!bookingId || !token) throw new Error('bookingId and token are required');
      const user = await resolveAuthenticatedUserFromToken(token);
      const booking = await canUserTrackBooking(user.userId, bookingId);
      if (!booking) throw new Error('Not authorized to track this booking');

      joinedRoom = roomFor(bookingId);
      joinedRoom.add(socket);
      sendJson(socket, {
        type: 'connected',
        bookingId,
        driverLocation: booking.driver
          ? {
            latitude: booking.driver.currentLatitude,
            longitude: booking.driver.currentLongitude,
          }
          : null,
      });
    } catch (err) {
      sendJson(socket, { type: 'error', message: err.message });
      socket.close(1008, 'Tracking authorization failed');
      return;
    }

    socket.on('close', () => {
      if (joinedRoom) {
        joinedRoom.delete(socket);
        if (joinedRoom.size === 0) rooms.delete(bookingId);
      }
    });
  });

  return wss;
}

function broadcastDriverLocation(bookingId, payload) {
  const room = rooms.get(bookingId);
  if (!room || room.size === 0) return;
  for (const socket of room) {
    sendJson(socket, {
      type: 'driver_location',
      bookingId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  }
}

module.exports = {
  ACTIVE_TRACKING_STATUSES,
  attachLiveTracking,
  broadcastDriverLocation,
  canUserTrackBooking,
};
