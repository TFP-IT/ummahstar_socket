/**
 * liveStreamService.js
 *
 * mediasoup SFU-based live streaming service.
 * Supports:
 *  - HalaqaLive: 1 host producer → many viewer consumers
 *  - Mashwara  : 2-peer bidirectional (both produce & consume)
 *
 * Socket event API (all prefixed with `live_stream_`):
 *   → live_stream_create_room
 *   → live_stream_join_room
 *   → live_stream_leave_room
 *   → live_stream_get_rtp_capabilities
 *   → live_stream_create_transport
 *   → live_stream_connect_transport
 *   → live_stream_produce
 *   → live_stream_consume
 *   → live_stream_resume_consumer
 *   → live_stream_toggle_media
 *   → live_stream_raise_hand
 *   → live_stream_chat_message
 *   → live_stream_kick_participant
 *   → live_stream_end_session
 *   → live_stream_get_participants
 */

const mediasoup = require('mediasoup');

// ─── mediasoup codec configuration ───────────────────────────────────────────
const MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {'x-google-start-bitrate': 1000},
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

// ─── TURN / ICE relay servers ────────────────────────────────────────────────
// The client receives these in every create_transport response so it can
// add them to the underlying RTCPeerConnection regardless of network type.
const TURN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      `turn:${process.env.TURN_HOST || 'pdf.mges.global'}:${process.env.TURN_PORT || 3478}?transport=udp`,
      `turn:${process.env.TURN_HOST || 'pdf.mges.global'}:${process.env.TURN_PORT || 3478}?transport=tcp`,
      `turns:${process.env.TURN_HOST || 'pdf.mges.global'}:${process.env.TURN_TLS_PORT || 5349}?transport=tcp`,
    ],
    username: process.env.TURN_USERNAME || 'videocall',
    credential: process.env.TURN_CREDENTIAL || '12345678&12345678',
  },
];

// WebRTC transport options
const WEBRTC_TRANSPORT_OPTIONS = {
  listenInfos: [
    {
      protocol: 'udp',
      ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
      announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || process.env.SERVER_IP || '127.0.0.1',
    },
    {
      protocol: 'tcp',
      ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
      announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || process.env.SERVER_IP || '127.0.0.1',
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  preferTcp: false,
  initialAvailableOutgoingBitrate: 1_000_000,
  minimumAvailableOutgoingBitrate: 600_000,
  maxSctpMessageSize: 262144,
  // How long to wait (ms) for ICE consent before closing the transport.
  // Default is 30 000 ms; lower it so failures are detected faster.
  iceConsentTimeout: 20,
};

// ─── Worker pool ──────────────────────────────────────────────────────────────
let mediasoupWorkers = [];
let workerIndex = 0;

async function createWorkers() {
  const numWorkers = Math.max(1, require('os').cpus().length);
  console.log(`[LiveStream] Creating ${numWorkers} mediasoup worker(s)...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 40000),
      rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 49999),
    });

    worker.on('died', () => {
      console.error(`[LiveStream] Worker ${worker.pid} died — restarting in 2s`);
      setTimeout(async () => {
        const newWorker = await mediasoup.createWorker({
          logLevel: 'warn',
          rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 40000),
          rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 49999),
        });
        mediasoupWorkers[i] = newWorker;
      }, 2000);
    });

    mediasoupWorkers.push(worker);
    console.log(`[LiveStream] Worker ${worker.pid} created`);
  }
}

function getNextWorker() {
  const worker = mediasoupWorkers[workerIndex % mediasoupWorkers.length];
  workerIndex++;
  return worker;
}

// ─── Service factory ──────────────────────────────────────────────────────────
function createLiveStreamService({io, liveStreamState}) {
  const {
    createRoom,
    getRoom,
    hasRoom,
    deleteRoom,
    addParticipant,
    removeParticipant,
    updateParticipant,
    getRoomParticipantList,
    addTransport,
    getTransport,
    addProducer,
    getProducer,
    getProducersByUser,
    getAllProducers,
    addConsumer,
    addChatMessage,
  } = liveStreamState;

  // Emit to everyone in the socket.io room for this session
  function broadcastToRoom(sessionId, event, data, excludeSocketId = null) {
    if (excludeSocketId) {
      io.to(sessionId).except(excludeSocketId).emit(event, data);
    } else {
      io.to(sessionId).emit(event, data);
    }
  }

  // ── handle: host creates a new live-stream room ───────────────────────────
  async function handleCreateRoom(socket, data, callback) {
    const {sessionId, userId, displayName, sessionType = 'halaqa'} = data;

    try {
      if (hasRoom(sessionId)) {
        // Room already exists — treat as re-join for the host
        return callback({
          success: false,
          error: 'Room already exists. Use join_room to re-connect.',
        });
      }

      const worker = getNextWorker();
      const router = await worker.createRouter({mediaCodecs: MEDIA_CODECS});

      createRoom(sessionId, userId, router);
      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Host',
      });

      socket.join(sessionId);

      console.log(`[LiveStream] Room created: ${sessionId} by user ${userId}`);

      callback({
        success: true,
        sessionId,
        rtpCapabilities: router.rtpCapabilities,
        sessionType,
      });
    } catch (error) {
      console.error('[LiveStream] handleCreateRoom error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: viewer / second peer joins the room ───────────────────────────
  async function handleJoinRoom(socket, data, callback) {
    const {sessionId, userId, displayName} = data;

    try {
      const room = getRoom(sessionId);
      if (!room) {
        return callback({success: false, error: 'Session not found. It may have ended.'});
      }

      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Viewer',
      });

      socket.join(sessionId);

      // Notify existing participants
      broadcastToRoom(sessionId, 'live_stream_participant_joined', {
        sessionId,
        userId: String(userId),
        displayName: displayName || 'Viewer',
        participants: getRoomParticipantList(sessionId),
        timestamp: new Date().toISOString(),
      }, socket.id);

      // Send existing producers so new joiner can consume them
      const existingProducers = getAllProducers(sessionId).map(p => ({
        producerId: p.producer.id,
        userId: p.userId,
        kind: p.kind,
      }));

      console.log(`[LiveStream] User ${userId} joined room ${sessionId}`);

      callback({
        success: true,
        sessionId,
        rtpCapabilities: room.router.rtpCapabilities,
        participants: getRoomParticipantList(sessionId),
        existingProducers,
        chatHistory: room.chatMessages.slice(-50),
        hostUserId: String(room.hostUserId),
      });
    } catch (error) {
      console.error('[LiveStream] handleJoinRoom error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: create a WebRTC send or receive transport ────────────────────
  async function handleCreateTransport(socket, data, callback) {
    const {sessionId, userId, direction} = data; // direction: 'send' | 'recv'

    try {
      const room = getRoom(sessionId);
      if (!room) {
        return callback({success: false, error: 'Session not found'});
      }

      const transport = await room.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS);

      // Log ICE candidates so we can verify the announced IP is reachable
      console.log(
        `[LiveStream] ${direction} transport ${transport.id} ICE candidates:`,
        transport.iceCandidates.map(c => `${c.protocol}:${c.ip}:${c.port}`).join(', '),
      );

      transport.on('dtlsstatechange', dtlsState => {
        console.log(`[LiveStream] Transport ${transport.id} dtlsState: ${dtlsState}`);
        if (dtlsState === 'closed') transport.close();
      });

      transport.on('icestatechange', iceState => {
        console.log(`[LiveStream] Transport ${transport.id} iceState: ${iceState}`);
      });

      // Set a bitrate limit so the server doesn't overload the connection
      await transport.setMaxIncomingBitrate(1_500_000);

      addTransport(sessionId, userId, direction, transport);

      // Return `id` (not just transportId) so mediasoup-client can consume
      // the params without any field-name mapping on the client side.
      // Also return TURN servers so the client adds them to its RTCPeerConnection.
      callback({
        success: true,
        id: transport.id,           // ← mediasoup-client wants `id`
        transportId: transport.id,  // ← keep for backward-compat
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        iceServers: TURN_SERVERS,   // ← client passes these to RTCPeerConnection
      });
    } catch (error) {
      console.error('[LiveStream] handleCreateTransport error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: client connects a transport (DTLS handshake) ─────────────────
  async function handleConnectTransport(socket, data, callback) {
    const {sessionId, transportId, dtlsParameters} = data;

    try {
      const record = getTransport(sessionId, transportId);
      if (!record) {
        return callback({success: false, error: 'Transport not found'});
      }

      await record.transport.connect({dtlsParameters});
      callback({success: true});
    } catch (error) {
      console.error('[LiveStream] handleConnectTransport error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: producer sends media (host / Mashwara peer) ──────────────────
  async function handleProduce(socket, data, callback) {
    const {sessionId, userId, transportId, kind, rtpParameters, appData} = data;

    try {
      const record = getTransport(sessionId, transportId);
      if (!record || record.direction !== 'send') {
        return callback({success: false, error: 'Send transport not found'});
      }

      const producer = await record.transport.produce({kind, rtpParameters, appData});

      producer.on('transportclose', () => {
        console.log(`[LiveStream] Producer ${producer.id} transport closed`);
      });

      addProducer(sessionId, userId, producer);

      // Notify all viewers in the room about new producer
      broadcastToRoom(sessionId, 'live_stream_new_producer', {
        sessionId,
        producerId: producer.id,
        userId: String(userId),
        kind,
      }, socket.id);

      console.log(`[LiveStream] Producer ${producer.id} (${kind}) by user ${userId} in ${sessionId}`);
      callback({success: true, producerId: producer.id});
    } catch (error) {
      console.error('[LiveStream] handleProduce error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: viewer requests to consume a producer ─────────────────────────
  async function handleConsume(socket, data, callback) {
    const {sessionId, userId, transportId, producerId, rtpCapabilities} = data;

    try {
      const room = getRoom(sessionId);
      if (!room) {
        return callback({success: false, error: 'Session not found'});
      }

      if (!room.router.canConsume({producerId, rtpCapabilities})) {
        return callback({success: false, error: 'Cannot consume: incompatible RTP capabilities'});
      }

      const record = getTransport(sessionId, transportId);
      if (!record || record.direction !== 'recv') {
        return callback({success: false, error: 'Recv transport not found'});
      }

      const consumer = await record.transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // start paused — client resumes after setup
      });

      consumer.on('transportclose', () => {
        console.log(`[LiveStream] Consumer ${consumer.id} transport closed`);
      });
      consumer.on('producerclose', () => {
        socket.emit('live_stream_producer_closed', {
          sessionId,
          consumerId: consumer.id,
          producerId,
        });
      });

      addConsumer(sessionId, userId, consumer, producerId);

      // Find the producer's owner
      const producerRecord = getProducer(sessionId, producerId);

      callback({
        success: true,
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerUserId: producerRecord ? producerRecord.userId : null,
      });
    } catch (error) {
      console.error('[LiveStream] handleConsume error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: client signals consumer is ready to receive ──────────────────
  async function handleResumeConsumer(socket, data, callback) {
    const {sessionId, consumerId} = data;

    try {
      const room = getRoom(sessionId);
      if (!room) return callback({success: false, error: 'Session not found'});

      const record = room.consumers.get(consumerId);
      if (!record) return callback({success: false, error: 'Consumer not found'});

      await record.consumer.resume();
      callback({success: true});
    } catch (error) {
      console.error('[LiveStream] handleResumeConsumer error:', error);
      callback({success: false, error: error.message});
    }
  }

  // ── handle: toggle audio/video mute ──────────────────────────────────────
  function handleToggleMedia(socket, data) {
    const {sessionId, userId, kind, muted} = data; // kind: 'audio'|'video'

    const patch = kind === 'audio' ? {audioMuted: muted} : {videoMuted: muted};
    updateParticipant(sessionId, userId, patch);

    broadcastToRoom(sessionId, 'live_stream_media_toggled', {
      sessionId,
      userId: String(userId),
      kind,
      muted,
      timestamp: new Date().toISOString(),
    });
  }

  // ── handle: raise / lower hand ────────────────────────────────────────────
  function handleRaiseHand(socket, data) {
    const {sessionId, userId, displayName, raised} = data;

    updateParticipant(sessionId, userId, {handRaised: raised});

    broadcastToRoom(sessionId, 'live_stream_hand_raised', {
      sessionId,
      userId: String(userId),
      displayName,
      raised,
      timestamp: new Date().toISOString(),
    });
  }

  // ── handle: in-session chat message ──────────────────────────────────────
  function handleChatMessage(socket, data) {
    const {sessionId, userId, displayName, message, avatarUrl} = data;

    const chatMsg = {
      id: `${Date.now()}-${userId}`,
      userId: String(userId),
      displayName,
      avatarUrl: avatarUrl || null,
      message,
      timestamp: new Date().toISOString(),
    };

    addChatMessage(sessionId, chatMsg);

    // Broadcast to everyone in room including sender
    io.to(sessionId).emit('live_stream_chat_message', {
      sessionId,
      ...chatMsg,
    });
  }

  // ── handle: host kicks a participant ─────────────────────────────────────
  function handleKickParticipant(socket, data) {
    const {sessionId, hostUserId, targetUserId} = data;

    const room = getRoom(sessionId);
    if (!room) return;

    // Verify caller is the host
    if (String(room.hostUserId) !== String(hostUserId)) {
      return socket.emit('live_stream_error', {error: 'Only the host can kick participants'});
    }

    // Notify the kicked user
    const target = room.participants.get(String(targetUserId));
    if (target && target.socketId) {
      io.to(target.socketId).emit('live_stream_kicked', {
        sessionId,
        reason: 'Removed by host',
      });
    }

    removeParticipant(sessionId, targetUserId);

    broadcastToRoom(sessionId, 'live_stream_participant_left', {
      sessionId,
      userId: String(targetUserId),
      reason: 'kicked',
      participants: getRoomParticipantList(sessionId),
    });
  }

  // ── handle: participant leaves ────────────────────────────────────────────
  function handleLeaveRoom(socket, data) {
    const {sessionId, userId} = data;

    _participantCleanup(socket, sessionId, userId, 'left');
  }

  // ── handle: host ends the entire session ─────────────────────────────────
  function handleEndSession(socket, data) {
    const {sessionId, hostUserId} = data;

    const room = getRoom(sessionId);
    if (!room) return;

    if (String(room.hostUserId) !== String(hostUserId)) {
      return socket.emit('live_stream_error', {error: 'Only the host can end the session'});
    }

    broadcastToRoom(sessionId, 'live_stream_session_ended', {
      sessionId,
      endedBy: String(hostUserId),
      timestamp: new Date().toISOString(),
    });

    deleteRoom(sessionId);
    io.socketsLeave(sessionId);
    console.log(`[LiveStream] Session ${sessionId} ended by host ${hostUserId}`);
  }

  // ── handle: get current participants list ─────────────────────────────────
  function handleGetParticipants(socket, data, callback) {
    const {sessionId} = data;
    const room = getRoom(sessionId);

    if (!room) {
      return callback({success: false, error: 'Session not found'});
    }

    callback({
      success: true,
      participants: getRoomParticipantList(sessionId),
      hostUserId: String(room.hostUserId),
    });
  }

  // ── internal: clean up when participant disconnects ───────────────────────
  function _participantCleanup(socket, sessionId, userId, reason = 'left') {
    if (!sessionId || !userId) return;

    const room = getRoom(sessionId);
    if (!room) return;

    const isHost = String(room.hostUserId) === String(userId);

    removeParticipant(sessionId, userId);
    socket.leave(sessionId);

    if (isHost) {
      // Host left → end the session for everyone
      broadcastToRoom(sessionId, 'live_stream_session_ended', {
        sessionId,
        endedBy: String(userId),
        reason: 'host_left',
        timestamp: new Date().toISOString(),
      });
      deleteRoom(sessionId);
      io.socketsLeave(sessionId);
      console.log(`[LiveStream] Session ${sessionId} ended because host left`);
    } else {
      broadcastToRoom(sessionId, 'live_stream_participant_left', {
        sessionId,
        userId: String(userId),
        reason,
        participants: getRoomParticipantList(sessionId),
        timestamp: new Date().toISOString(),
      });

      // Notify remaining viewers about lost producers from this user
      const userProducers = getProducersByUser(sessionId, userId);
      userProducers.forEach(p => {
        broadcastToRoom(sessionId, 'live_stream_producer_closed', {
          sessionId,
          producerId: p.producer.id,
          userId: String(userId),
        });
      });

      console.log(`[LiveStream] User ${userId} left room ${sessionId}`);
    }
  }

  // ── on socket disconnect: clean up all rooms this socket was in ───────────
  function handleSocketDisconnect(socket, socketUserId) {
    if (!socketUserId) return;

    // Find all rooms this user was in and clean up
    const {getAllRooms} = liveStreamState;
    getAllRooms().forEach(({sessionId}) => {
      const room = getRoom(sessionId);
      if (!room) return;
      if (room.participants.has(String(socketUserId))) {
        _participantCleanup(socket, sessionId, socketUserId, 'disconnect');
      }
    });
  }

  return {
    createWorkers,
    handleCreateRoom,
    handleJoinRoom,
    handleCreateTransport,
    handleConnectTransport,
    handleProduce,
    handleConsume,
    handleResumeConsumer,
    handleToggleMedia,
    handleRaiseHand,
    handleChatMessage,
    handleKickParticipant,
    handleLeaveRoom,
    handleEndSession,
    handleGetParticipants,
    handleSocketDisconnect,
  };
}

module.exports = {createLiveStreamService, createWorkers};
