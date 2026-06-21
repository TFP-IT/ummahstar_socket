function createMashwaraService({io, mashwaraState, socketState, pushService, queryDb}) {
  // Tracks pending session-teardown timers keyed by sessionId.
  // When a participant disconnects unexpectedly we wait RECONNECT_GRACE_MS
  // before firing mashwara_session_ended so they can rejoin on reconnect.
  const reconnectTimers = new Map();
  const RECONNECT_GRACE_MS = 15000; // 15 s grace period

  function cancelReconnectTimer(sessionId) {
    const timer = reconnectTimers.get(String(sessionId));
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(String(sessionId));
    }
  }
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
    room.liveChatId = data.liveChatId ?? data.live_chat_id ?? data.mashwaraId ?? data.mashwara_id ?? null;
    room.registrationId = data.registrationId ?? data.registration_id ?? null;

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

  async function releasePayout(liveChatId, guestUserId) {
    if (!queryDb || !liveChatId || !guestUserId) {
      return;
    }
    try {
      console.log(`[Mashwara Payout] Attempting to release payout for liveChatId: ${liveChatId}, guestUserId: ${guestUserId}`);
      const result = await queryDb(
        `
          UPDATE transactions
          SET payout_status = 'released', updated_at = NOW()
          WHERE user_id = ? AND event_id = ? AND event = 'livechat' AND status = '1' AND payout_status = 'held'
        `,
        [guestUserId, liveChatId]
      );
      console.log(`[Mashwara Payout] Release result:`, result);
    } catch (err) {
      console.error('[Mashwara Payout] Error releasing payout:', err);
    }
  }

  async function handleReleasePayout(socket, data) {
    const {sessionId, userId} = data || {};
    const room = getRoom(sessionId);
    if (!room) {
      return;
    }
    const guestUserId = room.remoteUserId;
    const liveChatId = room.liveChatId;
    if (!guestUserId || !liveChatId) {
      console.warn(`[Mashwara Payout] Cannot release payout, guestUserId: ${guestUserId}, liveChatId: ${liveChatId}`);
      return;
    }
    await releasePayout(liveChatId, guestUserId);
  }

  async function checkAndReleasePayout(room, isHost) {
    if (!isHost && room) {
      const guestUserId = room.remoteUserId;
      const liveChatId = room.liveChatId;
      if (guestUserId && liveChatId) {
        await releasePayout(liveChatId, guestUserId);
      }
    }
  }

  async function notifyIncomingCall({sessionId, userId, displayName, remoteUserId, data = {}}) {
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
      callType: data.callType || data.call_type || 'mashwaraAudio',
      registrationId: data.registrationId ?? data.registration_id ?? null,
      liveChatId:
        data.liveChatId ??
        data.live_chat_id ??
        data.mashwaraId ??
        data.mashwara_id ??
        null,
      slotId: data.slotId ?? data.slot_id ?? null,
      liveChatDate: data.liveChatDate ?? data.live_chat_date ?? null,
      liveChatStartTime:
        data.liveChatStartTime ?? data.live_chat_start_time ?? null,
      liveChatEndTime:
        data.liveChatEndTime ?? data.live_chat_end_time ?? null,
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
          ...payload,
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
      await notifyIncomingCall({sessionId, userId, displayName, remoteUserId, data});

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
    // If the user is rejoining after a disconnect, cancel any pending teardown.
    cancelReconnectTimer((data || {}).sessionId);
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
        audioMuted: Boolean(data.audioMuted),
        videoMuted: Boolean(data.videoMuted),
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
        audioMuted: Boolean(data.audioMuted),
        videoMuted: Boolean(data.videoMuted),
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
        // Cancel any pending disconnect-grace timer so it doesn't fire after
        // the host has explicitly ended the session.
        cancelReconnectTimer(sessionId);

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
    const isHostDeclined = String(recipient_id) === String(room.hostUserId);

    if (!isHostDeclined) {
      checkAndReleasePayout(room, false).catch(error => {
        console.error('[Mashwara] Failed to auto-release payout on user decline:', error);
      });
    }

    updateHistoryRecord(room, {
      receiverUserId: recipient_id,
      status: 'declined',
      endedAt,
      ringDurationSeconds,
      endReason: 'declined',
      meta: {
        endedByUserId: String(recipient_id),
        endedByRole:
          isHostDeclined ? 'host' : 'participant',
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
      const finalReason =
        reason === 'disconnect'
          ? (isHost ? 'host_disconnected' : 'participant_disconnected')
          : (isHost ? 'host_left' : 'participant_left');

      // For intentional leaves (host_left / participant_left) end immediately.
      // For unexpected disconnects, wait RECONNECT_GRACE_MS before tearing
      // down so the client can reconnect and rejoin without losing the session.
      const isUnexpectedDisconnect = reason === 'disconnect';

      const doTeardown = () => {
        // Re-check the room still exists and is still nearly empty.
        const currentRoom = getRoom(sessionId);
        if (!currentRoom) {
          return; // Already cleaned up (e.g. explicit end_session fired first).
        }

        reconnectTimers.delete(String(sessionId));

        const endedAt = new Date();
        const durationSeconds = toWholeSeconds(currentRoom.startedAt || currentRoom.answeredAt, endedAt);
        const billableMinutes = toBillableMinutes(durationSeconds);
        const totalFee = Number((billableMinutes * toMoney(currentRoom.feePerMinute)).toFixed(2));
        const historyStatus =
          finalReason.includes('disconnected') && !currentRoom.answeredAt
            ? 'missed'
            : finalReason.includes('disconnected')
              ? 'failed'
              : 'ended';

        checkAndReleasePayout(currentRoom, isHost).catch(error => {
          console.error('[Mashwara] Failed to auto-release payout on leave:', error);
        });

        updateHistoryRecord(currentRoom, {
          status: historyStatus,
          endedAt,
          ringDurationSeconds:
            currentRoom.answeredAt
              ? currentRoom.ringDurationSeconds || 0
              : toWholeSeconds(currentRoom.ringingAt || currentRoom.initiatedAt, endedAt),
          durationSeconds,
          billableMinutes,
          totalFee,
          endReason: finalReason,
          failureReason: finalReason.includes('disconnected') ? 'socket_disconnect' : null,
          meta: {
            endedByUserId: String(userId),
            endedByRole: isHost ? 'host' : 'participant',
            endSource: reason,
            remainingParticipantCount: currentRoom.participants.size,
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
      };

      if (isUnexpectedDisconnect) {
        // Cancel any existing timer for this session (e.g. both sides disconnect
        // at the same time) and schedule a fresh one.
        cancelReconnectTimer(sessionId);
        console.log(
          `[Mashwara] Disconnect grace period started for session ${sessionId} (user ${userId}, ${RECONNECT_GRACE_MS}ms)`,
        );
        const timer = setTimeout(doTeardown, RECONNECT_GRACE_MS);
        reconnectTimers.set(String(sessionId), timer);
      } else {
        // Intentional leave — end immediately.
        doTeardown();
      }
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
    handleReleasePayout,
    handleSocketDisconnect,
  };
}

module.exports = {
  createMashwaraService,
};
