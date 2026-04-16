const {
  CALL_TIMEOUT_MS,
  STALE_CALL_MS,
  STALE_CALL_CLEANUP_INTERVAL_MS,
} = require('../../config/constants');

function createCallService({io, queryDb, socketState, pushService}) {
  const {activeCalls, getOnlineUser} = socketState;

  function normalizeCallType(callType) {
    const normalized = String(callType || '').toLowerCase();

    if (normalized === 'audio' || normalized === 'voice') {
      return 'voice';
    }

    if (normalized === 'video') {
      return 'video';
    }

    return 'voice';
  }

  function normalizeCallStatus(status) {
    const normalized = String(status ?? '')
      .trim()
      .toLowerCase();

    if (normalized === 'initiated') {
      return 'initiated';
    }

    if (normalized === 'ringing') {
      return 'ringing';
    }

    if (
      normalized === 'active' ||
      normalized === 'ongoing' ||
      normalized === 'answered'
    ) {
      return 'ongoing';
    }

    if (
      normalized === 'ended' ||
      normalized === 'completed' ||
      normalized === 'finished'
    ) {
      return 'completed';
    }

    if (
      normalized === 'failed' ||
      normalized === 'missed' ||
      normalized === 'timeout'
    ) {
      return 'missed';
    }

    if (
      normalized === 'declined' ||
      normalized === 'rejected' ||
      normalized === 'decline'
    ) {
      return 'rejected';
    }

    return 'initiated';
  }

  function buildCallEventPayload(call, extra = {}) {
    return {
      callId: call.callId,
      callDbId: call.dbCallId || null,
      conversation_id: call.conversation_id,
      callType: call.clientCallType || call.callType,
      status: normalizeCallStatus(call.status),
      started_at: call.started_at ? call.started_at.toISOString() : null,
      ended_at: call.ended_at ? call.ended_at.toISOString() : null,
      duration: call.duration || 0,
      caller_info: call.caller_info,
      ...extra,
    };
  }

  async function createCallRecord(callInfo) {
    const result = await queryDb(
      `
        INSERT INTO calls (
          uuid,
          conversation_id,
          initiator_id,
          type,
          status,
          started_at,
          ended_at,
          duration,
          sdp_offer,
          sdp_answer,
          ice_candidates,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, NOW(), NOW())
      `,
      [
        callInfo.callId,
        callInfo.conversation_id,
        callInfo.caller_id,
        callInfo.callType,
        normalizeCallStatus(callInfo.status),
      ],
    );

    callInfo.status = normalizeCallStatus(callInfo.status);
    callInfo.dbCallId = result.insertId;
    return callInfo;
  }

  async function insertCallParticipant(callId, userId, status, options = {}) {
    const {joinedAt = null, leftAt = null} = options;

    await queryDb(
      `
        INSERT INTO call_participants (
          call_id,
          user_id,
          status,
          joined_at,
          left_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [callId, userId, status, joinedAt, leftAt],
    );
  }

  async function updateCallParticipant(callId, userId, status, options = {}) {
    const {joinedAt, leftAt} = options;

    await queryDb(
      `
        UPDATE call_participants
        SET
          status = ?,
          joined_at = COALESCE(?, joined_at),
          left_at = COALESCE(?, left_at),
          updated_at = NOW()
        WHERE call_id = ? AND user_id = ?
      `,
      [status, joinedAt ?? null, leftAt ?? null, callId, userId],
    );
  }

  async function updateCallRecord(call, fields = {}) {
    const nextStartedAt =
      fields.startedAt === undefined ? call.started_at : fields.startedAt;
    const nextEndedAt =
      fields.endedAt === undefined ? call.ended_at : fields.endedAt;
    const nextDuration =
      fields.duration === undefined ? call.duration || 0 : fields.duration;
    const nextStatus = normalizeCallStatus(fields.status ?? call.status);
    const nextOffer =
      fields.sdpOffer === undefined ? call.sdp_offer || null : fields.sdpOffer;
    const nextAnswer =
      fields.sdpAnswer === undefined
        ? call.sdp_answer || null
        : fields.sdpAnswer;
    const nextIceCandidates =
      fields.iceCandidates === undefined
        ? call.ice_candidates || null
        : fields.iceCandidates;

    await queryDb(
      `
        UPDATE calls
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          duration = ?,
          sdp_offer = ?,
          sdp_answer = ?,
          ice_candidates = ?,
          updated_at = NOW()
        WHERE id = ?
      `,
      [
        nextStatus,
        nextStartedAt,
        nextEndedAt,
        nextDuration,
        nextOffer,
        nextAnswer,
        nextIceCandidates,
        call.dbCallId,
      ],
    );

    call.status = nextStatus;
    call.started_at = nextStartedAt;
    call.ended_at = nextEndedAt;
    call.duration = nextDuration;
    call.sdp_offer = nextOffer;
    call.sdp_answer = nextAnswer;
    call.ice_candidates = nextIceCandidates;

    return call;
  }

  function getOtherParticipant(call, currentUserId) {
    return call.participants.find(id => Number(id) !== Number(currentUserId));
  }

  function createCallInfo(data) {
    const normalizedCallType = normalizeCallType(data.callType);

    return {
      callId: data.callId,
      callType: normalizedCallType,
      clientCallType: data.callType || normalizedCallType,
      conversation_id: data.conversation_id,
      caller_id: data.caller_id,
      recipient_id: data.recipient_id,
      participants: [data.caller_id, data.recipient_id],
      status: 'ringing',
      start_time: new Date(),
      started_at: null,
      ended_at: null,
      duration: 0,
      dbCallId: data.callDbId || null,
      sdp_offer: null,
      sdp_answer: null,
      ice_candidates: null,
      caller_info: data.caller_info,
    };
  }

  function setCallStatus(call, status) {
    call.status = normalizeCallStatus(status);
    return call.status;
  }

  function getExistingActiveCallForUser(userId) {
    return Array.from(activeCalls.values()).find(
      call =>
        call.participants.includes(userId) &&
        (call.status === 'ongoing' || call.status === 'ringing'),
    );
  }

  function emitCallEndedToParticipants(call, payload) {
    call.participants.forEach(userId => {
      const user = getOnlineUser(userId);
      if (user) {
        io.to(user.socketId).emit('call_ended', payload);
      }
    });
  }

  function cleanupStaleCallsForParticipants(participants) {
    const staleCallIds = [];

    activeCalls.forEach((call, callId) => {
      const containsParticipant = participants.some(participantId =>
        call.participants.includes(participantId),
      );

      if (!containsParticipant) return;

      const age = Date.now() - call.start_time.getTime();
      const isStale =
        age > STALE_CALL_MS ||
        call.status === 'missed' ||
        call.status === 'rejected' ||
        call.status === 'completed';

      if (isStale) {
        staleCallIds.push(callId);
      }
    });

    staleCallIds.forEach(callId => {
      console.log(`Cleaning stale call ${callId}`);
      activeCalls.delete(callId);
    });
  }

  function cleanupUserCalls(userId, reason = 'cleanup') {
    const affectedCalls = Array.from(activeCalls.entries()).filter(([, call]) =>
      call.participants.includes(userId),
    );

    affectedCalls.forEach(([callId, call]) => {
      (async () => {
        const endedAt = new Date();
        const otherUserId = getOtherParticipant(call, userId);
        const otherUser = getOnlineUser(otherUserId);
        const duration = call.answer_time
          ? Math.floor((endedAt - call.answer_time) / 1000)
          : 0;

        await updateCallRecord(call, {
          status: reason === 'disconnect' ? 'missed' : 'completed',
          endedAt,
          duration,
        });
        await updateCallParticipant(call.dbCallId, userId, 'left', {
          leftAt: endedAt,
        });
        await updateCallParticipant(call.dbCallId, otherUserId, 'left', {
          leftAt: endedAt,
        });

        if (otherUser) {
          io.to(otherUser.socketId).emit(
            'call_ended',
            buildCallEventPayload(call, {
              ended_by: userId,
              reason,
              timestamp: endedAt.toISOString(),
              participant_status: 'left',
            }),
          );
        }
      })().catch(error => {
        console.error('Failed to cleanup user call:', error);
      }).finally(() => {
        activeCalls.delete(callId);
      });
    });

    return affectedCalls.length;
  }

  async function handleOfflineIncomingCall(callInfo) {
    try {
      const rows = await queryDb(
        `
          SELECT device_id
          FROM users
          WHERE id = ?
          LIMIT 1
        `,
        [callInfo.recipient_id],
      );

      const recipient = rows[0];
      if (!recipient) {
        console.log(`Recipient ${callInfo.recipient_id} not found`);
        return;
      }

      const callerName = callInfo.caller_info?.name || 'Someone';
      const title =
        callInfo.callType === 'audio'
          ? 'Incoming voice call'
          : 'Incoming video call';
      const body = `${callerName} is calling you`;

      await pushService.sendPushToToken(recipient.device_id, title, body, {
        type: 'incoming_call',
        callId: callInfo.callId,
        callDbId: callInfo.dbCallId,
        callType: callInfo.callType,
        conversation_id: callInfo.conversation_id,
        caller_id: callInfo.caller_id,
        caller_name: callerName,
        caller_avatar: callInfo.caller_info?.avatar || null,
        status: callInfo.status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to send offline incoming call push:', error);
    }
  }

  function scheduleUnansweredCallTimeout(socket, callInfo) {
    setTimeout(() => {
      const currentCall = activeCalls.get(callInfo.callId);
      if (!currentCall || currentCall.status !== 'ringing') {
        return;
      }

      (async () => {
        const endedAt = new Date();
        await updateCallRecord(currentCall, {
          status: 'missed',
          endedAt,
          duration: 0,
        });
        await updateCallParticipant(
          currentCall.dbCallId,
          currentCall.caller_id,
          'left',
          {leftAt: endedAt},
        );
        await updateCallParticipant(
          currentCall.dbCallId,
          currentCall.recipient_id,
          'left',
          {leftAt: endedAt},
        );

        socket.emit(
          'call_failed',
          buildCallEventPayload(currentCall, {
            error: 'No answer',
            reason: 'timeout',
            timestamp: endedAt.toISOString(),
          }),
        );

        const recipient = getOnlineUser(currentCall.recipient_id);
        if (recipient) {
          io.to(recipient.socketId).emit(
            'call_missed',
            buildCallEventPayload(currentCall, {
              timestamp: endedAt.toISOString(),
            }),
          );
        }
      })().catch(error => {
        console.error('Failed to persist unanswered call timeout:', error);
      }).finally(() => {
        activeCalls.delete(callInfo.callId);
      });
    }, CALL_TIMEOUT_MS);
  }

  async function handleInitiateCall(socket, data) {
    console.log('Call initiated:', data);

    const recipient = getOnlineUser(data.recipient_id);
    cleanupStaleCallsForParticipants([data.caller_id, data.recipient_id]);

    if (getExistingActiveCallForUser(data.caller_id)) {
      socket.emit('call_failed', {
        callId: data.callId,
        error: 'You are already in a call',
        reason: 'caller_busy',
      });
      return;
    }

    if (getExistingActiveCallForUser(data.recipient_id)) {
      socket.emit('call_failed', {
        callId: data.callId,
        error: 'User is busy',
        reason: 'user_busy',
      });
      return;
    }

    const callInfo = await createCallRecord(createCallInfo(data));
    await insertCallParticipant(callInfo.dbCallId, callInfo.caller_id, 'joined', {
      joinedAt: callInfo.start_time,
    });
    await insertCallParticipant(
      callInfo.dbCallId,
      callInfo.recipient_id,
      'invited',
    );
    activeCalls.set(callInfo.callId, callInfo);

    if (recipient) {
      io.to(recipient.socketId).emit(
        'incoming_call',
        buildCallEventPayload(callInfo, {
          timestamp: new Date().toISOString(),
          participant_status: 'invited',
        }),
      );
    } else {
      await handleOfflineIncomingCall(callInfo);
    }

    scheduleUnansweredCallTimeout(socket, callInfo);
  }

  function handleAnswerCall(socket, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      socket.emit('call_error', {error: 'Call not found'});
      return;
    }

    (async () => {
      setCallStatus(call, 'ongoing');
      call.answer_time = new Date();
      call.started_at = call.answer_time;

      await updateCallRecord(call, {
        status: 'ongoing',
        startedAt: call.answer_time,
      });
      await updateCallParticipant(call.dbCallId, data.recipient_id, 'joined', {
        joinedAt: call.answer_time,
      });

      const payload = buildCallEventPayload(call, {
        recipient_id: data.recipient_id,
        timestamp: new Date().toISOString(),
        participant_status: 'joined',
      });

      const caller = getOnlineUser(call.caller_id);
      if (caller) {
        io.to(caller.socketId).emit('call_answered', payload);
      }

      socket.emit('call_answered', payload);
    })().catch(error => {
      console.error('Failed to persist answered call:', error);
      socket.emit('call_error', {error: 'Failed to answer call'});
    });
  }

  function handleDeclineCall(socket, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      socket.emit('call_error', {error: 'Call not found'});
      return;
    }

    (async () => {
      const endedAt = new Date();
      setCallStatus(call, 'rejected');
      call.ended_at = endedAt;

      await updateCallRecord(call, {
        status: 'rejected',
        endedAt,
        duration: 0,
      });
      await updateCallParticipant(call.dbCallId, call.caller_id, 'left', {
        leftAt: endedAt,
      });
      await updateCallParticipant(call.dbCallId, data.recipient_id, 'declined', {
        leftAt: endedAt,
      });

      const payload = buildCallEventPayload(call, {
        declined_by: data.recipient_id,
        timestamp: endedAt.toISOString(),
        participant_status: 'declined',
      });

      const caller = getOnlineUser(call.caller_id);
      if (caller) {
        io.to(caller.socketId).emit('call_declined', payload);
      }

      socket.emit('call_declined', payload);
      activeCalls.delete(data.callId);
    })().catch(error => {
      console.error('Failed to persist declined call:', error);
      socket.emit('call_error', {error: 'Failed to decline call'});
    });
  }

  function handleEndCall(socket, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      socket.emit('call_error', {error: 'Call not found'});
      return;
    }

    (async () => {
      const endTime = new Date();
      const duration = call.answer_time
        ? Math.floor((endTime - call.answer_time) / 1000)
        : 0;

      await updateCallRecord(call, {
        status: 'completed',
        endedAt: endTime,
        duration,
      });
      await updateCallParticipant(call.dbCallId, data.user_id, 'left', {
        leftAt: endTime,
      });
      await updateCallParticipant(
        call.dbCallId,
        getOtherParticipant(call, data.user_id),
        'left',
        {leftAt: endTime},
      );

      const payload = buildCallEventPayload(call, {
        ended_by: data.user_id,
        duration,
        timestamp: endTime.toISOString(),
        participant_status: 'left',
      });

      const otherUser = getOnlineUser(getOtherParticipant(call, data.user_id));
      if (otherUser) {
        io.to(otherUser.socketId).emit('call_ended', payload);
      }

      socket.emit('call_ended', payload);
      activeCalls.delete(data.callId);
    })().catch(error => {
      console.error('Failed to persist ended call:', error);
      socket.emit('call_error', {error: 'Failed to end call'});
    });
  }

  function relayCallSignal(eventName, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      console.log(`Call ${data.callId} not found for ${eventName}`);
      return;
    }

    const targetUser = getOnlineUser(getOtherParticipant(call, data.sender_id));
    if (!targetUser) {
      console.log(`Target user not found for ${eventName}`);
      return;
    }

    (async () => {
      if (eventName === 'webrtc_offer') {
        await updateCallRecord(call, {
          sdpOffer: JSON.stringify(data.offer),
        });
      } else if (eventName === 'webrtc_answer') {
        await updateCallRecord(call, {
          sdpAnswer: JSON.stringify(data.answer),
        });
      } else if (eventName === 'webrtc_ice_candidate') {
        let iceCandidates = [];

        if (call.ice_candidates) {
          try {
            iceCandidates = JSON.parse(call.ice_candidates);
          } catch {
            iceCandidates = [];
          }
        }

        iceCandidates.push({
          sender_id: data.sender_id,
          candidate: data.candidate,
          captured_at: new Date().toISOString(),
        });

        await updateCallRecord(call, {
          iceCandidates: JSON.stringify(iceCandidates),
        });
      }

      io.to(targetUser.socketId).emit(
        eventName,
        buildCallEventPayload(call, data),
      );
    })().catch(error => {
      console.error(`Failed to persist ${eventName}:`, error);
    });
  }

  function emitCallStatus(socket, callId) {
    const call = activeCalls.get(callId);
    const payload = {
      callId,
      callDbId: call?.dbCallId || null,
      call: call || null,
      exists: Boolean(call),
      status: call ? call.status : null,
      participants: call ? call.participants : [],
    };

    socket.emit('call_status', payload);
    socket.emit('call_status_response', payload);
  }

  function registerCleanupInterval() {
    setInterval(() => {
      const now = Date.now();

      activeCalls.forEach((call, callId) => {
        const callAge = now - call.start_time.getTime();
        const isStale =
          callAge > STALE_CALL_MS ||
          (call.status !== 'ongoing' && call.status !== 'ringing');

        if (!isStale) {
          return;
        }

        emitCallEndedToParticipants(call, {
          ...buildCallEventPayload(call),
          reason: 'stale_cleanup',
          timestamp: new Date(now).toISOString(),
        });

        updateCallRecord(call, {
          status: 'missed',
          endedAt: new Date(now),
          duration: call.answer_time
            ? Math.floor((now - call.answer_time.getTime()) / 1000)
            : 0,
        })
          .then(() =>
            Promise.all(
              call.participants.map(userId =>
                updateCallParticipant(call.dbCallId, userId, 'left', {
                  leftAt: new Date(now),
                }),
              ),
            ),
          )
          .catch(error => {
            console.error('Failed to persist stale call cleanup:', error);
          })
          .finally(() => {
            activeCalls.delete(callId);
          });
      });
    }, STALE_CALL_CLEANUP_INTERVAL_MS);
  }

  return {
    handleInitiateCall,
    handleAnswerCall,
    handleDeclineCall,
    handleEndCall,
    relayCallSignal,
    emitCallStatus,
    cleanupUserCalls,
    registerCleanupInterval,
  };
}

module.exports = {
  createCallService,
};
