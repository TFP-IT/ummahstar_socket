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

  function normalizeCallMode(callType) {
    const normalized = String(callType || '').trim().toLowerCase();

    if (normalized.includes('video')) {
      return 'video';
    }

    return 'audio';
  }

  function toMysqlDateTime(value) {
    if (!value) {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date;
  }

  function toMoney(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toWholeSeconds(startAt, endAt) {
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) {
      return 0;
    }

    return Math.max(0, Math.floor((endAt.getTime() - startAt.getTime()) / 1000));
  }

  function toBillableMinutes(durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0) {
      return 0;
    }

    return Math.ceil(durationSeconds / 60);
  }

  async function createHistoryRecord(room, data = {}) {
    if (!queryDb || !room?.sessionId) {
      return null;
    }

    const initiatedAt = new Date();
    const callTypeRaw = data.callType || data.call_type || 'mashwaraAudio';
    const callMode = normalizeCallMode(callTypeRaw);
    const feePerMinute = toMoney(data.feePerMinute ?? data.fee_per_minute ?? data.fee);
    const meta = {
      sessionType: data.sessionType ?? 'mashwara',
      source: 'socket',
    };

    const result = await queryDb(
      `
        INSERT INTO live_chat_join_histories (
          session_id,
          live_chat_id,
          registration_id,
          host_user_id,
          joined_by_user_id,
          call_mode,
          status,
          scheduled_at,
          initiated_at,
          ringing_at,
          joined_at,
          fee_per_minute,
          billable_minutes,
          total_fee,
          notes,
          meta,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        room.sessionId,
        data.liveChatId ??
          data.live_chat_id ??
          data.mashwaraId ??
          data.mashwara_id ??
          null,
        data.registrationId ?? data.registration_id ?? null,
        room.hostUserId,
        null,
        callMode,
        'ringing',
        toMysqlDateTime(data.scheduledAt ?? data.scheduled_at),
        initiatedAt,
        initiatedAt,
        null,
        feePerMinute,
        0,
        0,
        null,
        JSON.stringify(meta),
      ],
    );

    room.historyId = result.insertId;
    room.callTypeRaw = callTypeRaw;
    room.callMode = callMode;
    room.feePerMinute = feePerMinute;
    room.initiatedAt = initiatedAt;
    room.ringingAt = initiatedAt;
    room.historyMeta = meta;

    return result.insertId;
  }

  async function updateHistoryRecord(room, patch = {}) {
    if (!queryDb || !room?.historyId) {
      return;
    }

    const nextStatus = patch.status ?? room.historyStatus ?? 'ringing';
    const nextCallMode = patch.callMode ?? room.callMode ?? 'audio';
    const nextStartedAt =
      patch.startedAt === undefined
        ? room.startedAt ?? null
        : patch.startedAt;
    const nextEndedAt =
      patch.endedAt === undefined
        ? room.endedAt ?? null
        : patch.endedAt;
    const nextEndReason =
      patch.endReason === undefined
        ? room.endReason ?? null
        : patch.endReason;
    const nextFailureReason =
      patch.failureReason === undefined
        ? room.failureReason ?? null
        : patch.failureReason;
    const nextRingDurationSeconds =
      patch.ringDurationSeconds === undefined
        ? room.ringDurationSeconds ?? 0
        : patch.ringDurationSeconds;
    const nextDurationSeconds =
      patch.durationSeconds === undefined
        ? room.durationSeconds ?? 0
        : patch.durationSeconds;
    const nextBillableMinutes =
      patch.billableMinutes === undefined
        ? room.billableMinutes ?? 0
        : patch.billableMinutes;
    const nextTotalFee =
      patch.totalFee === undefined
        ? room.totalFee ?? 0
        : patch.totalFee;
    const nextMeta = {
      ...(room.historyMeta || {}),
      ...(patch.meta || {}),
    };

    await queryDb(
      `
        UPDATE live_chat_join_histories
        SET
          joined_by_user_id = COALESCE(?, joined_by_user_id),
          call_mode = ?,
          status = ?,
          joined_at = COALESCE(?, joined_at),
          started_at = ?,
          ended_at = ?,
          ring_duration_seconds = ?,
          session_duration_seconds = ?,
          billable_minutes = ?,
          total_fee = ?,
          end_reason = ?,
          failure_reason = ?,
          notes = COALESCE(?, notes),
          meta = COALESCE(?, meta),
          updated_at = NOW()
        WHERE id = ?
      `,
      [
        patch.receiverUserId ?? null,
        nextCallMode,
        nextStatus,
        toMysqlDateTime(patch.joinedAt ?? patch.answeredAt ?? room.joinedAt ?? room.answeredAt),
        toMysqlDateTime(nextStartedAt),
        toMysqlDateTime(nextEndedAt),
        nextRingDurationSeconds,
        nextDurationSeconds,
        nextBillableMinutes,
        nextTotalFee,
        nextEndReason,
        nextFailureReason,
        patch.notes ?? null,
        patch.meta ? JSON.stringify(nextMeta) : null,
        room.historyId,
      ],
    );

    room.historyStatus = nextStatus;
    room.callMode = nextCallMode;
    room.joinedAt =
      patch.joinedAt ??
      patch.answeredAt ??
      room.joinedAt ??
      room.answeredAt ??
      null;
    room.startedAt = nextStartedAt;
    room.endedAt = nextEndedAt;
    room.endReason = nextEndReason;
    room.failureReason = nextFailureReason;
    room.ringDurationSeconds = nextRingDurationSeconds;
    room.durationSeconds = nextDurationSeconds;
    room.billableMinutes = nextBillableMinutes;
    room.totalFee = nextTotalFee;
    room.historyMeta = nextMeta;
    if (patch.receiverUserId) {
      room.receiverUserId = String(patch.receiverUserId);
    }
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
        return callback({
          success: false,
          error: 'sessionId and userId are required',
          message: 'sessionId and userId are required',
        });
      }

      if (hasRoom(sessionId)) {
        return callback({
          success: false,
          error: 'Room already exists. Use mashwara_join_room.',
          message: 'Room already exists. Use mashwara_join_room.',
        });
      }

      const room = createRoom(sessionId, userId, {remoteUserId});
      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Host',
        audioMuted: false,
        videoMuted: normalizeCallMode(data.callType || data.call_type) !== 'video',
      });
      await createHistoryRecord(room, data);

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
      callback({
        success: false,
        error: error.message,
        message: error.message,
      });
    }
  }

  function handleJoinRoom(socket, data, callback) {
    const {sessionId, userId, displayName} = data || {};

    try {
      const room = getRoom(sessionId);
      if (!room) {
        return callback({
          success: false,
          error: 'Mashwara session not found',
          message: 'Mashwara session not found',
        });
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
          message: 'This Mashwara call is reserved for another participant',
        });
      }

      if (!isExistingParticipant && room.participants.size >= 2) {
        return callback({
          success: false,
          error: 'Mashwara call already has two participants',
          message: 'Mashwara call already has two participants',
        });
      }

      addParticipant(sessionId, userId, {
        socketId: socket.id,
        displayName: displayName || 'Guest',
      });

      socket.join(String(sessionId));

      const joinedAt = new Date();
      const shouldMarkAnswered =
        String(userId) !== String(room.hostUserId) &&
        !room.answeredAt;

      const ringDurationSeconds = shouldMarkAnswered
        ? toWholeSeconds(room.ringingAt || room.initiatedAt || room.startedAt, joinedAt)
        : room.ringDurationSeconds || 0;

      const updateHistoryPromise = shouldMarkAnswered
        ? updateHistoryRecord(room, {
            receiverUserId: userId,
            status: 'joined',
            answeredAt: joinedAt,
            startedAt: joinedAt,
            ringDurationSeconds,
            meta: {
              joinedByUserId: String(userId),
              joinedByRole: isHost ? 'host' : 'participant',
            },
          })
        : Promise.resolve();

      const payload = {
        sessionId: String(sessionId),
        userId: String(userId),
        displayName: displayName || 'Guest',
        participants: getParticipantList(sessionId),
        timestamp: new Date().toISOString(),
      };

      emitToOtherParticipants(room, userId, 'mashwara_participant_joined', payload);
      Promise.resolve(updateHistoryPromise)
        .then(() => {
          callback({
            success: true,
            sessionId: String(sessionId),
            hostUserId: String(room.hostUserId),
            remoteUserId: room.remoteUserId,
            participants: getParticipantList(sessionId),
          });
        })
        .catch(error => {
          console.error('[Mashwara] Failed to persist join history:', error);
          callback({
            success: false,
            error: 'Failed to update call history',
            message: error.message || 'Failed to update call history',
          });
        });
      return;
    } catch (error) {
      console.error('[Mashwara] handleJoinRoom error:', error);
      callback({
        success: false,
        error: error.message,
        message: error.message,
      });
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

    if (kind === 'video' && muted === false && room.callMode !== 'video') {
      updateHistoryRecord(room, {
        callMode: 'video',
        meta: {
          upgradedToVideoByUserId: String(userId),
          upgradedToVideoAt: new Date().toISOString(),
        },
      }).catch(error => {
        console.error('[Mashwara] Failed to persist call_mode upgrade to video:', error);
      });
    }
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
      return callback({
        success: false,
        error: 'Mashwara session not found',
        message: 'Mashwara session not found',
      });
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

    const endedAt = new Date();
    const durationSeconds = toWholeSeconds(room.startedAt || room.answeredAt, endedAt);
    const billableMinutes = toBillableMinutes(durationSeconds);
    const totalFee = Number((billableMinutes * toMoney(room.feePerMinute)).toFixed(2));

    updateHistoryRecord(room, {
      status: 'ended',
      endedAt,
      durationSeconds,
      billableMinutes,
      totalFee,
      endReason: 'host_ended',
      meta: {
        endedByUserId: String(hostUserId),
        endedByRole: 'host',
        endSource: 'end_session',
      },
    })
      .catch(error => {
        console.error('[Mashwara] Failed to persist ended session history:', error);
      })
      .finally(() => {
        io.to(String(sessionId)).emit('mashwara_session_ended', {
          sessionId: String(sessionId),
          endedBy: String(hostUserId),
          reason: 'host_ended',
          timestamp: endedAt.toISOString(),
        });

        deleteRoom(sessionId);
        io.socketsLeave(String(sessionId));
      });
  }

  function handleDeclineCall(socket, data) {
    const {sessionId, recipient_id} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }

    const endedAt = new Date();
    const ringDurationSeconds = toWholeSeconds(room.ringingAt || room.initiatedAt, endedAt);

    updateHistoryRecord(room, {
      receiverUserId: recipient_id,
      status: 'declined',
      endedAt,
      ringDurationSeconds,
      endReason: 'declined',
      meta: {
        endedByUserId: String(recipient_id),
        endedByRole:
          String(recipient_id) === String(room.hostUserId) ? 'host' : 'participant',
        endSource: 'decline',
      },
    })
      .catch(error => {
        console.error('[Mashwara] Failed to persist declined session history:', error);
      })
      .finally(() => {
        io.to(String(sessionId)).emit('mashwara_session_ended', {
          sessionId: String(sessionId),
          endedBy: String(recipient_id),
          reason: 'declined',
          timestamp: endedAt.toISOString(),
        });

        deleteRoom(sessionId);
        io.socketsLeave(String(sessionId));
      });
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

    if (room.participants.size <= 1) {
      const endedAt = new Date();
      const finalReason =
        reason === 'disconnect'
          ? (isHost ? 'host_disconnected' : 'participant_disconnected')
          : (isHost ? 'host_left' : 'participant_left');
      const durationSeconds = toWholeSeconds(room.startedAt || room.answeredAt, endedAt);
      const billableMinutes = toBillableMinutes(durationSeconds);
      const totalFee = Number((billableMinutes * toMoney(room.feePerMinute)).toFixed(2));
      const historyStatus =
        finalReason.includes('disconnected') && !room.answeredAt
          ? 'missed'
          : finalReason.includes('disconnected')
            ? 'failed'
            : 'ended';

      updateHistoryRecord(room, {
        status: historyStatus,
        endedAt,
        ringDurationSeconds:
          room.answeredAt
            ? room.ringDurationSeconds || 0
            : toWholeSeconds(room.ringingAt || room.initiatedAt, endedAt),
        durationSeconds,
        billableMinutes,
        totalFee,
        endReason: finalReason,
        failureReason: finalReason.includes('disconnected') ? 'socket_disconnect' : null,
        meta: {
          endedByUserId: String(userId),
          endedByRole: isHost ? 'host' : 'participant',
          endSource: reason,
          remainingParticipantCount: room.participants.size,
        },
      })
        .catch(error => {
          console.error('[Mashwara] Failed to persist leave/disconnect history:', error);
        })
        .finally(() => {
          io.to(String(sessionId)).emit('mashwara_session_ended', {
            sessionId: String(sessionId),
            endedBy: String(userId),
            reason: finalReason,
            timestamp: endedAt.toISOString(),
          });
          deleteRoom(sessionId);
          io.socketsLeave(String(sessionId));
        });
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
