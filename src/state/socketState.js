function toNumericId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createSocketState() {
  const connectedUsers = new Map();
  const onlineUsers = new Map();
  const activeCalls = new Map();

  function getConnectedUsersPayload() {
    return Array.from(connectedUsers.entries()).map(([userId, socketId]) => ({
      userId,
      socketId,
    }));
  }

  function getOnlineUsersPayload() {
    return Array.from(onlineUsers.entries()).map(([id, socketId]) => ({
      id,
      socketId,
    }));
  }

  function getOnlineUser(userId) {
    const normalizedUserId = toNumericId(userId);
    if (normalizedUserId === null) return null;

    const socketId = onlineUsers.get(normalizedUserId);
    return socketId ? {id: normalizedUserId, socketId} : null;
  }

  function setConnectedUser(user, socketId) {
    const normalizedUserId = toNumericId(user?.id ?? user);
    if (normalizedUserId === null) return null;

    connectedUsers.set(normalizedUserId, socketId);
    return normalizedUserId;
  }

  function setOnlineUser(userId, socketId) {
    const normalizedUserId = toNumericId(userId);
    if (normalizedUserId === null) return null;

    onlineUsers.set(normalizedUserId, socketId);
    return normalizedUserId;
  }

  function removeSocketReferences(socketId) {
    let disconnectedConnectedUserId = null;
    let disconnectedOnlineUserId = null;

    for (const [userId, connectedSocketId] of connectedUsers.entries()) {
      if (connectedSocketId === socketId) {
        disconnectedConnectedUserId = userId;
        connectedUsers.delete(userId);
        break;
      }
    }

    for (const [userId, onlineSocketId] of onlineUsers.entries()) {
      if (onlineSocketId === socketId) {
        disconnectedOnlineUserId = userId;
        onlineUsers.delete(userId);
        break;
      }
    }

    return {
      disconnectedConnectedUserId,
      disconnectedOnlineUserId,
    };
  }

  return {
    connectedUsers,
    onlineUsers,
    activeCalls,
    toNumericId,
    getConnectedUsersPayload,
    getOnlineUsersPayload,
    getOnlineUser,
    setConnectedUser,
    setOnlineUser,
    removeSocketReferences,
  };
}

module.exports = {
  createSocketState,
};
