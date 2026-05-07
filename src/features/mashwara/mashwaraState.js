function createMashwaraState() {
  const rooms = new Map();

  function createRoom(sessionId, hostUserId, meta = {}) {
    const room = {
      sessionId: String(sessionId),
      hostUserId: String(hostUserId),
      remoteUserId: meta.remoteUserId ? String(meta.remoteUserId) : null,
      participants: new Map(),
      startedAt: new Date(),
    };

    rooms.set(String(sessionId), room);
    return room;
  }

  function getRoom(sessionId) {
    return rooms.get(String(sessionId)) || null;
  }

  function hasRoom(sessionId) {
    return rooms.has(String(sessionId));
  }

  function deleteRoom(sessionId) {
    rooms.delete(String(sessionId));
  }

  function addParticipant(sessionId, userId, info = {}) {
    const room = getRoom(sessionId);
    if (!room) {
      return null;
    }

    const participant = {
      userId: String(userId),
      socketId: info.socketId || null,
      displayName: info.displayName || 'User',
      audioMuted: Boolean(info.audioMuted),
      videoMuted: Boolean(info.videoMuted),
      joinedAt: new Date(),
    };

    room.participants.set(String(userId), participant);
    return participant;
  }

  function updateParticipant(sessionId, userId, patch = {}) {
    const room = getRoom(sessionId);
    if (!room) {
      return null;
    }

    const existing = room.participants.get(String(userId));
    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...patch,
    };

    room.participants.set(String(userId), updated);
    return updated;
  }

  function removeParticipant(sessionId, userId) {
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    room.participants.delete(String(userId));
  }

  function getParticipantList(sessionId) {
    const room = getRoom(sessionId);
    if (!room) {
      return [];
    }

    return Array.from(room.participants.values());
  }

  function getAllRooms() {
    return Array.from(rooms.values()).map(room => ({
      sessionId: room.sessionId,
      hostUserId: room.hostUserId,
      remoteUserId: room.remoteUserId,
      participantCount: room.participants.size,
      startedAt: room.startedAt,
    }));
  }

  return {
    createRoom,
    getRoom,
    hasRoom,
    deleteRoom,
    addParticipant,
    updateParticipant,
    removeParticipant,
    getParticipantList,
    getAllRooms,
  };
}

module.exports = {
  createMashwaraState,
};
