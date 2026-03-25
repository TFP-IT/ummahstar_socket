const {
  CALL_TIMEOUT_MS,
  STALE_CALL_MS,
  STALE_CALL_CLEANUP_INTERVAL_MS,
} = require('../../config/constants');

function createCallService({io, queryDb, socketState, pushService}) {
  const {activeCalls, getOnlineUser} = socketState;

  function getOtherParticipant(call, currentUserId) {
    return call.participants.find(id => Number(id) !== Number(currentUserId));
  }

  function createCallInfo(data) {
    return {
      callId: data.callId,
      callType: data.callType,
      conversation_id: data.conversation_id,
      caller_id: data.caller_id,
      recipient_id: data.recipient_id,
      participants: [data.caller_id, data.recipient_id],
      status: 'ringing',
      start_time: new Date(),
      caller_info: data.caller_info,
    };
  }

  function getExistingActiveCallForUser(userId) {
    return Array.from(activeCalls.values()).find(
      call =>
        call.participants.includes(userId) &&
        (call.status === 'active' || call.status === 'ringing'),
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
        call.status === 'failed' ||
        call.status === 'declined';

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
      const otherUserId = getOtherParticipant(call, userId);
      const otherUser = getOnlineUser(otherUserId);

      if (otherUser) {
        io.to(otherUser.socketId).emit('call_ended', {
          callId,
          conversation_id: call.conversation_id,
          ended_by: userId,
          reason,
          timestamp: new Date().toISOString(),
        });
      }

      activeCalls.delete(callId);
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
        callType: callInfo.callType,
        conversation_id: callInfo.conversation_id,
        caller_id: callInfo.caller_id,
        caller_name: callerName,
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

      socket.emit('call_failed', {
        callId: callInfo.callId,
        error: 'No answer',
        reason: 'timeout',
      });

      const recipient = getOnlineUser(callInfo.recipient_id);
      if (recipient) {
        io.to(recipient.socketId).emit('call_missed', {
          callId: callInfo.callId,
          caller_info: callInfo.caller_info,
        });
      }

      currentCall.status = 'failed';
      activeCalls.delete(callInfo.callId);
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

    const callInfo = createCallInfo(data);
    activeCalls.set(callInfo.callId, callInfo);

    if (recipient) {
      io.to(recipient.socketId).emit('incoming_call', {
        callId: callInfo.callId,
        callType: callInfo.callType,
        conversation_id: callInfo.conversation_id,
        caller_info: callInfo.caller_info,
        timestamp: new Date().toISOString(),
      });
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

    call.status = 'active';
    call.answer_time = new Date();

    const caller = getOnlineUser(call.caller_id);
    if (caller) {
      io.to(caller.socketId).emit('call_answered', {
        callId: data.callId,
        conversation_id: data.conversation_id,
        recipient_id: data.recipient_id,
        timestamp: new Date().toISOString(),
      });
    }
  }

  function handleDeclineCall(socket, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      socket.emit('call_error', {error: 'Call not found'});
      return;
    }

    call.status = 'declined';

    const caller = getOnlineUser(call.caller_id);
    if (caller) {
      io.to(caller.socketId).emit('call_declined', {
        callId: data.callId,
        conversation_id: data.conversation_id,
        declined_by: data.recipient_id,
        timestamp: new Date().toISOString(),
      });
    }

    activeCalls.delete(data.callId);
  }

  function handleEndCall(socket, data) {
    const call = activeCalls.get(data.callId);
    if (!call) {
      socket.emit('call_error', {error: 'Call not found'});
      return;
    }

    const endTime = new Date();
    const duration = call.answer_time
      ? Math.floor((endTime - call.answer_time) / 1000)
      : 0;

    const otherUser = getOnlineUser(getOtherParticipant(call, data.user_id));
    if (otherUser) {
      io.to(otherUser.socketId).emit('call_ended', {
        callId: data.callId,
        conversation_id: data.conversation_id,
        ended_by: data.user_id,
        duration,
        timestamp: endTime.toISOString(),
      });
    }

    activeCalls.delete(data.callId);
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

    io.to(targetUser.socketId).emit(eventName, data);
  }

  function emitCallStatus(socket, callId) {
    const call = activeCalls.get(callId);
    const payload = {
      callId,
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
          (call.status !== 'active' && call.status !== 'ringing');

        if (!isStale) {
          return;
        }

        emitCallEndedToParticipants(call, {
          callId,
          conversation_id: call.conversation_id,
          reason: 'stale_cleanup',
          timestamp: new Date(now).toISOString(),
        });

        activeCalls.delete(callId);
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
