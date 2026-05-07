function createMashwaraService({io, mashwaraState, socketState, pushService, queryDb}) {
  const {
    createRoom,
    getRoom,
    hasRoom,
    deleteRoom,
    addParticipant,
    updateParticipant,
    removeParticipant,
    getParticipantList,
    getAllRooms,
  } = mashwaraState;

  function emitToParticipant(socketId, eventName, payload) {
    if (!socketId) {
      return;
    }

    io.to(socketId).emit(eventName, payload);
  }

  function emitToOtherParticipants(room, senderUserId, eventName, payload) {
    if (!room) {
      return;
    }

    room.participants.forEach(participant => {
      if (String(participant.userId) === String(senderUserId)) {
        return;
      }

      emitToParticipant(participant.socketId, eventName, payload);
    });
  }

  async function notifyIncomingCall({sessionId, userId, displayName, remoteUserId}) {
    if (!remoteUserId) {
      return;
    }

    const recipient =
      socketState.getOnlineUser(remoteUserId) ||
      socketState.getConnectedUser?.(remoteUserId);

    const payload = {
      sessionId: String(sessionId),
      caller_id: userId,
      caller_name: displayName || 'Someone',
      timestamp: new Date().toISOString(),
    };

    if (recipient?.socketId) {
      emitToParticipant(recipient.socketId, 'incoming_mashwara_call', payload);
      return;
    }

    if (!pushService || !queryDb) {
      return;
    }

    try {
      const rows = await queryDb(
        'SELECT device_id FROM users WHERE id = ? LIMIT 1',
        [remoteUserId],
      );

      if (!rows?.[0]?.device_id) {
        return;
      }

      await pushService.sendPushToToken(
        rows[0].device_id,
        'Incoming Mashwara Call',
        `${displayName || 'Someone'} is calling you for Mashwara`,
        {
          type: 'incoming_mashwara_call',
          sessionId: String(sessionId),
          caller_id: userId,
          caller_name: displayName || 'Someone',
          timestamp: new Date().toISOString(),
        },
      );
    } catch (error) {
      console.error('[Mashwara] Failed to send incoming call notification:', error);
    }
  }

  async function handleCreateRoom(socket, data, callback) {
    const {sessionId, userId, displayName, remoteUserId} = data || {};

    try {
      if (!sessionId || !userId) {
        return callback({success: false, error: 'sessionId and userId are required'});
      }

      if (hasRoom(sessionId)) {
        return callback({success: false, error: 'Room already exists. Use mashwara_join_room.'});
      }

      createRoom(sessionId, userId, {remoteUserId});
      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Host',
      });

      socket.join(String(sessionId));
      await notifyIncomingCall({sessionId, userId, displayName, remoteUserId});

      callback({
        success: true,
        sessionId: String(sessionId),
        hostUserId: String(userId),
        remoteUserId: remoteUserId ? String(remoteUserId) : null,
        participants: getParticipantList(sessionId),
      });
    } catch (error) {
      console.error('[Mashwara] handleCreateRoom error:', error);
      callback({success: false, error: error.message});
    }
  }

  function handleJoinRoom(socket, data, callback) {
    const {sessionId, userId, displayName} = data || {};

    try {
      const room = getRoom(sessionId);
      if (!room) {
        return callback({success: false, error: 'Mashwara session not found'});
      }

      const normalizedUserId = String(userId);
      const isHost = normalizedUserId === String(room.hostUserId);
      const isReservedGuest =
        room.remoteUserId && normalizedUserId === String(room.remoteUserId);
      const isExistingParticipant = room.participants.has(normalizedUserId);

      if (!isHost && room.remoteUserId && !isReservedGuest) {
        return callback({
          success: false,
          error: 'This Mashwara call is reserved for another participant',
        });
      }

      if (!isExistingParticipant && room.participants.size >= 2) {
        return callback({
          success: false,
          error: 'Mashwara call already has two participants',
        });
      }

      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Guest',
      });

      socket.join(String(sessionId));

      const payload = {
        sessionId: String(sessionId),
        userId: String(userId),
        displayName: displayName || 'Guest',
        participants: getParticipantList(sessionId),
        timestamp: new Date().toISOString(),
      };

      emitToOtherParticipants(room, userId, 'mashwara_participant_joined', payload);

      callback({
        success: true,
        sessionId: String(sessionId),
        hostUserId: String(room.hostUserId),
        remoteUserId: room.remoteUserId,
        participants: getParticipantList(sessionId),
      });
    } catch (error) {
      console.error('[Mashwara] handleJoinRoom error:', error);
      callback({success: false, error: error.message});
    }
  }

  function handleToggleMedia(socket, data) {
    const {sessionId, userId, kind, muted} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    updateParticipant(sessionId, userId, {
      [`${kind}Muted`]: Boolean(muted),
    });

    emitToOtherParticipants(room, userId, 'mashwara_media_toggled', {
      sessionId: String(sessionId),
      userId: String(userId),
      kind,
      muted: Boolean(muted),
      timestamp: new Date().toISOString(),
    });
  }

  function handleSignal(socket, data) {
    const {sessionId, senderId} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    emitToOtherParticipants(room, senderId, 'mashwara_signal', data);
  }

  function handleGetParticipants(socket, data, callback) {
    const {sessionId} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return callback({success: false, error: 'Mashwara session not found'});
    }

    callback({
      success: true,
      sessionId: String(sessionId),
      hostUserId: String(room.hostUserId),
      remoteUserId: room.remoteUserId,
      participants: getParticipantList(sessionId),
    });
  }

  function handleEndSession(socket, data) {
    const {sessionId, hostUserId} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    if (String(room.hostUserId) !== String(hostUserId)) {
      socket.emit('mashwara_error', {error: 'Only the host can end the session'});
      return;
    }

    io.to(String(sessionId)).emit('mashwara_session_ended', {
      sessionId: String(sessionId),
      endedBy: String(hostUserId),
      reason: 'host_ended',
      timestamp: new Date().toISOString(),
    });

    deleteRoom(sessionId);
    io.socketsLeave(String(sessionId));
  }

  function handleDeclineCall(socket, data) {
    const {sessionId, recipient_id} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    io.to(String(sessionId)).emit('mashwara_session_ended', {
      sessionId: String(sessionId),
      endedBy: String(recipient_id),
      reason: 'declined',
      timestamp: new Date().toISOString(),
    });

    deleteRoom(sessionId);
    io.socketsLeave(String(sessionId));
  }

  function handleLeaveRoom(socket, data, reason = 'left') {
    const {sessionId, userId} = data || {};
    if (!sessionId || !userId) {
      return;
    }

    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    const isHost = String(room.hostUserId) === String(userId);
    removeParticipant(sessionId, userId);
    socket.leave(String(sessionId));

    if (isHost || room.participants.size === 0) {
      io.to(String(sessionId)).emit('mashwara_session_ended', {
        sessionId: String(sessionId),
        endedBy: String(userId),
        reason: isHost ? 'host_left' : reason,
        timestamp: new Date().toISOString(),
      });
      deleteRoom(sessionId);
      io.socketsLeave(String(sessionId));
      return;
    }

    emitToOtherParticipants(room, userId, 'mashwara_participant_left', {
      sessionId: String(sessionId),
      userId: String(userId),
      reason,
      participants: getParticipantList(sessionId),
      timestamp: new Date().toISOString(),
    });
  }

  function handleSocketDisconnect(socket, socketUserId) {
    if (!socketUserId) {
      return;
    }

    getAllRooms().forEach(({sessionId}) => {
      const room = getRoom(sessionId);
      if (!room?.participants.has(String(socketUserId))) {
        return;
      }

      handleLeaveRoom(socket, {sessionId, userId: socketUserId}, 'disconnect');
    });
  }

  return {
    handleCreateRoom,
    handleJoinRoom,
    handleToggleMedia,
    handleSignal,
    handleGetParticipants,
    handleEndSession,
    handleDeclineCall,
    handleLeaveRoom,
    handleSocketDisconnect,
  };
}

module.exports = {
  createMashwaraService,
};
