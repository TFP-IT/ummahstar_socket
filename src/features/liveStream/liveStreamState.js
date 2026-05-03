/**
 * liveStreamState.js
 * In-memory state for all active live-stream rooms.
 *
 * Shape per room:
 * {
 *   sessionId  : string,
 *   router     : mediasoup.Router,
 *   hostUserId : number,
 *   transports : Map<transportId, {transport, userId, direction}>,
 *   producers  : Map<producerId, {producer, userId, kind}>,
 *   consumers  : Map<consumerId, {consumer, userId, producerId}>,
 *   participants: Map<userId, {socketId, displayName, audioMuted, videoMuted, handRaised}>,
 *   chatMessages: Array,
 *   startedAt  : Date,
 * }
 */
function createLiveStreamState() {
  // sessionId → room object
  const rooms = new Map();

  function createRoom(sessionId, hostUserId, router) {
    const room = {
      sessionId,
      router,
      hostUserId,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      participants: new Map(),
      chatMessages: [],
      startedAt: new Date(),
    };
    rooms.set(sessionId, room);
    return room;
  }

  function getRoom(sessionId) {
    return rooms.get(sessionId) || null;
  }

  function hasRoom(sessionId) {
    return rooms.has(sessionId);
  }

  function deleteRoom(sessionId) {
    const room = rooms.get(sessionId);
    if (!room) return;

    // Close mediasoup objects cleanly
    room.consumers.forEach(({consumer}) => {
      try { consumer.close(); } catch (_) {}
    });
    room.producers.forEach(({producer}) => {
      try { producer.close(); } catch (_) {}
    });
    room.transports.forEach(({transport}) => {
      try { transport.close(); } catch (_) {}
    });
    try { room.router.close(); } catch (_) {}

    rooms.delete(sessionId);
  }

  function addParticipant(sessionId, userId, info) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.participants.set(String(userId), {
      userId: String(userId),
      socketId: info.socketId || null,
      displayName: info.displayName || 'User',
      audioMuted: false,
      videoMuted: false,
      handRaised: false,
      joinedAt: new Date(),
    });
  }

  function removeParticipant(sessionId, userId) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.participants.delete(String(userId));

    // Close and remove transports belonging to this user
    const ownTransportIds = [];
    room.transports.forEach((t, tId) => {
      if (String(t.userId) === String(userId)) ownTransportIds.push(tId);
    });
    ownTransportIds.forEach(tId => {
      try { room.transports.get(tId).transport.close(); } catch (_) {}
      room.transports.delete(tId);
    });

    // Close and remove producers belonging to this user
    const ownProducerIds = [];
    room.producers.forEach((p, pId) => {
      if (String(p.userId) === String(userId)) ownProducerIds.push(pId);
    });
    ownProducerIds.forEach(pId => {
      try { room.producers.get(pId).producer.close(); } catch (_) {}
      room.producers.delete(pId);
    });

    // Close and remove consumers belonging to this user
    const ownConsumerIds = [];
    room.consumers.forEach((c, cId) => {
      if (String(c.userId) === String(userId)) ownConsumerIds.push(cId);
    });
    ownConsumerIds.forEach(cId => {
      try { room.consumers.get(cId).consumer.close(); } catch (_) {}
      room.consumers.delete(cId);
    });
  }

  function updateParticipant(sessionId, userId, patch) {
    const room = rooms.get(sessionId);
    if (!room) return;
    const existing = room.participants.get(String(userId));
    if (!existing) return;
    room.participants.set(String(userId), {...existing, ...patch});
  }

  function getRoomParticipantList(sessionId) {
    const room = rooms.get(sessionId);
    if (!room) return [];
    return Array.from(room.participants.values());
  }

  function addTransport(sessionId, userId, direction, transport) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.transports.set(transport.id, {transport, userId: String(userId), direction});
  }

  function getTransport(sessionId, transportId) {
    const room = rooms.get(sessionId);
    if (!room) return null;
    return room.transports.get(transportId) || null;
  }

  function addProducer(sessionId, userId, producer) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.producers.set(producer.id, {producer, userId: String(userId), kind: producer.kind});
  }

  function getProducer(sessionId, producerId) {
    const room = rooms.get(sessionId);
    if (!room) return null;
    return room.producers.get(producerId) || null;
  }

  function getProducersByUser(sessionId, userId) {
    const room = rooms.get(sessionId);
    if (!room) return [];
    return Array.from(room.producers.values()).filter(p => String(p.userId) === String(userId));
  }

  function getAllProducers(sessionId) {
    const room = rooms.get(sessionId);
    if (!room) return [];
    return Array.from(room.producers.values());
  }

  function addConsumer(sessionId, userId, consumer, producerId) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.consumers.set(consumer.id, {consumer, userId: String(userId), producerId});
  }

  function addChatMessage(sessionId, message) {
    const room = rooms.get(sessionId);
    if (!room) return;
    room.chatMessages.push(message);
    // Keep only last 200 messages in memory
    if (room.chatMessages.length > 200) {
      room.chatMessages.shift();
    }
  }

  function getAllRooms() {
    return Array.from(rooms.entries()).map(([sessionId, room]) => ({
      sessionId,
      hostUserId: room.hostUserId,
      participantCount: room.participants.size,
      producerCount: room.producers.size,
      startedAt: room.startedAt,
    }));
  }

  return {
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
    getAllRooms,
  };
}

module.exports = {createLiveStreamState};
