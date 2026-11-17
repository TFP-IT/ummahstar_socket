const {
  withVerifiedIdentity,
  isEnforceMode,
} = require('./socketAuth');

/**
 * Per-event security rules.
 *  ids:          payload fields that identify the *sender*; they are replaced
 *                with the token-verified user id so nobody can act as someone else.
 *  conversation: payload field holding a conversation id the sender must belong to.
 *  call:         payload field holding a 1:1 call id the sender must be part of.
 *  mashwara:     payload field holding a Mashwara session id the sender must be
 *                the host or the reserved guest of.
 */
const EVENT_RULES = {
  join_room: {ids: ['user_id'], conversation: 'conversation_id'},
  addUser: {ids: ['__self__']},
  get_online_user: {ids: ['__self__']},
  chat_screen_presence: {ids: ['user_id'], conversation: 'conversation_id'},

  initiate_call: {ids: ['caller_id']},
  answer_call: {ids: ['recipient_id'], call: 'callId'},
  decline_call: {ids: ['recipient_id'], call: 'callId'},
  end_call: {ids: ['user_id'], call: 'callId'},
  webrtc_offer: {ids: ['sender_id'], call: 'callId'},
  webrtc_answer: {ids: ['sender_id'], call: 'callId'},
  webrtc_ice_candidate: {ids: ['sender_id'], call: 'callId'},
  get_call_status: {call: 'callId'},
  cleanup_my_calls: {ids: ['userId']},
  debug_active_calls: {debugOnly: true},

  upload_file: {conversation: 'conversation_id'},
  send_message: {ids: ['user_id'], conversation: 'conversation_id'},
  mark_message_delivered: {ids: ['userId'], conversation: 'conversationId'},
  mark_message_read: {ids: ['userId'], conversation: 'conversationId'},
  get_messages: {conversation: 'conversation_id'},
  message_reaction: {ids: ['userId'], conversation: 'conversationId'},

  mashwara_create_room: {ids: ['userId']},
  mashwara_join_room: {ids: ['userId']},
  mashwara_leave_room: {ids: ['userId'], mashwara: 'sessionId'},
  mashwara_toggle_media: {ids: ['userId'], mashwara: 'sessionId'},
  mashwara_signal: {ids: ['senderId'], mashwara: 'sessionId'},
  mashwara_end_session: {ids: ['hostUserId']},
  mashwara_decline_call: {ids: ['recipient_id'], mashwara: 'sessionId'},
  mashwara_get_participants: {mashwara: 'sessionId'},
  mashwara_register_user: {ids: ['userId']},

  live_stream_create_room: {ids: ['userId']},
  live_stream_join_room: {ids: ['userId']},
  live_stream_leave_room: {ids: ['userId']},
  live_stream_create_transport: {ids: ['userId']},
  live_stream_produce: {ids: ['userId']},
  live_stream_consume: {ids: ['userId']},
  live_stream_toggle_media: {ids: ['userId']},
  live_stream_raise_hand: {ids: ['userId']},
  live_stream_chat_message: {ids: ['userId']},
  live_stream_kick_participant: {ids: ['hostUserId']},
  live_stream_end_session: {ids: ['hostUserId']},
  live_stream_decline_call: {ids: ['recipient_id']},
  live_stream_register_user: {ids: ['userId']},
};

function emitSocketError(socket, error, extra = {}) {
  socket.emit('message_error', {
    error,
    ...extra,
  });
}

function buildMessagePushBody(message) {
  const messageType = String(message?.message_type || 'text').toLowerCase();
  const rawContent = String(message?.encrypted_content || '').trim();

  if (messageType === 'text' && rawContent) {
    return 'Sent you a new message';
  }

  switch (messageType) {
    case 'image':
      return 'Sent you an image';
    case 'audio':
      return 'Sent you a voice message';
    case 'video':
      return 'Sent you a video';
    case 'document':
    case 'file':
      return 'Sent you a file';
    default:
      return 'Sent you a message';
  }
}

function registerSocketHandlers({io, socketState, services, verifyToken, queryDb}) {
  const {
    getOnlineUser,
    getOnlineUsersPayload,
    getConnectedUsersPayload,
    setConnectedUser,
    setOnlineUser,
    setActiveConversationView,
    isUserActivelyViewingConversation,
    removeSocketReferences,
  } = socketState;

  const {
    callService,
    mashwaraService,
    messageService,
    uploadService,
    qnaService,
    pushService,
    notificationPrefs,
  } = services;

  function emitOnlineUsers() {
    io.emit('receive_online_user', {
      activeUser: getOnlineUsersPayload(),
    });
  }

  function emitConnectedUsers() {
    io.emit('getUsers', getConnectedUsersPayload());
  }

  callService.registerCleanupInterval();

  async function isConversationParticipant(conversationId, userId) {
    if (!queryDb) return true;
    const rows = await queryDb(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
      [conversationId, userId],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  io.on('connection', socket => {
    console.log(`Socket connected: ${socket.id}`);
    socket.data = socket.data || {};
    const conversationAccess = new Map(); // conversationId -> boolean

    const rejectEvent = (event, args, reason) => {
      const callback = args.find(arg => typeof arg === 'function');
      const payload = {success: false, error: reason, message: reason, event};
      if (callback) callback(payload);
      socket.emit('auth_error', payload);
    };

    const canAccessConversation = async (conversationId, userId) => {
      const key = String(conversationId);
      if (conversationAccess.has(key)) return conversationAccess.get(key);
      const allowed = await isConversationParticipant(conversationId, userId);
      conversationAccess.set(key, allowed);
      return allowed;
    };

    const canAccessMashwara = (sessionId, userId) => {
      const state = services.mashwaraState;
      const room = state && sessionId ? state.getRoom(String(sessionId)) : null;
      if (!room) return true; // nothing to protect; the service handles "not found"
      const uid = String(userId);
      return (
        uid === String(room.hostUserId) ||
        (room.remoteUserId && uid === String(room.remoteUserId)) ||
        room.participants.has(uid)
      );
    };

    const canAccessCall = (callId, userId) => {
      const call = callId ? socketState.activeCalls.get(callId) : null;
      if (!call) return true; // the call service reports "not found" itself
      return (call.participants || []).map(String).includes(String(userId));
    };

    // Wrap only the events listed in EVENT_RULES; everything else is untouched.
    const rawOn = socket.on.bind(socket);
    socket.on = (event, handler) => {
      const rule = EVENT_RULES[event];
      if (!rule) return rawOn(event, handler);

      return rawOn(event, async (data, ...args) => {
        try {
          if (rule.debugOnly && process.env.SOCKET_DEBUG !== '1') {
            return rejectEvent(event, args, 'Disabled');
          }

          const userId = socket.data.userId;
          if (!userId) {
            if (isEnforceMode()) {
              return rejectEvent(event, args, 'Unauthorized');
            }
            return handler(data, ...args); // legacy client (compat mode)
          }

          const payload = withVerifiedIdentity(data, userId, rule.ids);
          const source = data && typeof data === 'object' ? data : {};

          if (rule.conversation) {
            const conversationId = source[rule.conversation];
            if (
              conversationId &&
              String(conversationId) !== '0' &&
              !(await canAccessConversation(conversationId, userId))
            ) {
              return rejectEvent(event, args, 'Not a member of this conversation');
            }
          }
          if (rule.call && !canAccessCall(source[rule.call], userId)) {
            return rejectEvent(event, args, 'Not a participant of this call');
          }
          if (rule.mashwara && !canAccessMashwara(source[rule.mashwara], userId)) {
            return rejectEvent(event, args, 'Not a participant of this Mashwara');
          }

          return handler(payload, ...args);
        } catch (error) {
          console.error(`[socketAuth] guard failed for ${event}:`, error.message);
          return rejectEvent(event, args, 'Server error');
        }
      });
    };

    // Lets a socket that connected before login attach its token later.
    rawOn('authenticate', async (data, callback) => {
      let userId = null;
      try {
        userId = verifyToken ? await verifyToken(data && data.token) : null;
      } catch (error) {
        console.error('[socketAuth] authenticate failed:', error.message);
      }
      if (userId) {
        if (socket.data.userId && socket.data.userId !== userId) {
          conversationAccess.clear();
        }
        socket.data.userId = userId;
      }
      if (typeof callback === 'function') {
        callback({success: Boolean(userId), userId: userId || null});
      }
    });
    
    // Dynamically grab liveStreamService because it initializes asynchronously
    const liveStreamService = services.liveStreamService;
    let mashwaraUserId = null;

    socket.on('join_sawal_jawab_room', roomId => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined sawal jawab room ${roomId}`);
    });

    socket.on('join_room', ({conversation_id, user_id}) => {
      socket.join(conversation_id);
      setConnectedUser(user_id, socket.id);
      console.log(`User ${user_id} joined conversation ${conversation_id}`);
    });

    socket.on('addUser', user => {
      setConnectedUser(user, socket.id);
      emitConnectedUsers();
    });

    socket.on('get_online_user', data => {
      const userId = setOnlineUser(data, socket.id);
      if (userId === null) return;

      emitOnlineUsers();
    });

    socket.on('chat_screen_presence', data => {
      setActiveConversationView(
        {
          userId: data?.user_id,
          conversationId: data?.conversation_id,
          isActive: Boolean(data?.is_active),
        },
        socket.id,
      );
    });

    socket.on('initiate_call', data => {
      callService.handleInitiateCall(socket, data);
    });

    socket.on('answer_call', data => {
      callService.handleAnswerCall(socket, data);
    });

    socket.on('decline_call', data => {
      callService.handleDeclineCall(socket, data);
    });

    socket.on('end_call', data => {
      callService.handleEndCall(socket, data);
    });

    socket.on('webrtc_offer', data => {
      callService.relayCallSignal('webrtc_offer', data);
    });

    socket.on('webrtc_answer', data => {
      callService.relayCallSignal('webrtc_answer', data);
    });

    socket.on('webrtc_ice_candidate', data => {
      callService.relayCallSignal('webrtc_ice_candidate', data);
    });

    socket.on('incoming_call_response', data => {
      console.log('Incoming call response:', data);
    });

    socket.on('get_call_status', data => {
      callService.emitCallStatus(socket, data.callId);
    });

    socket.on('upload_file', async uploadData => {
      try {
        const {uuid, conversation_id, fileName, fileData, messageType} =
          uploadData;

        if (!fileData || !fileName || !conversation_id) {
          socket.emit('file_uploaded', {
            success: false,
            error: 'Missing required fields',
            received: {
              hasFileData: Boolean(fileData),
              hasFileName: Boolean(fileName),
              hasConversationId: Boolean(conversation_id),
            },
          });
          return;
        }

        const uploadedFile = await uploadService.saveBase64File({
          uuid,
          fileName,
          fileData,
          messageType,
        });

        socket.emit('file_uploaded', {
          success: true,
          file_url: uploadedFile.fileUrl,
          fileName: uploadedFile.fileName,
          originalName: fileName,
          storage: uploadedFile.storage || 's3',
        });
      } catch (error) {
        console.error('File upload failed:', error);
        socket.emit('file_uploaded', {
          success: false,
          error: error.message || 'File upload failed',
        });
      }
    });

    socket.on('get_presigned_url', async (data, callback) => {
      // Upload URLs are for logged-in users only, in every auth mode.
      if (!socket.data?.userId) {
        const denied = {success: false, error: 'Unauthorized'};
        if (typeof callback === 'function') {
          callback(denied);
        } else {
          socket.emit('presigned_url_response', denied);
        }
        return;
      }
      try {
        const {fileName, messageType, fileType, uuid} = data || {};
        const res = await uploadService.generatePresignedUploadUrl({
          fileName,
          messageType,
          fileType,
          uuid,
        });

        if (typeof callback === 'function') {
          callback({success: true, ...res});
        } else {
          socket.emit('presigned_url_response', {success: true, ...res});
        }
      } catch (error) {
        console.error('generatePresignedUploadUrl failed:', error);
        if (typeof callback === 'function') {
          callback({success: false, error: error.message});
        } else {
          socket.emit('presigned_url_response', {
            success: false,
            error: error.message,
          });
        }
      }
    });

    socket.on('send_message', async message => {
      try {
        const savedMessage = await messageService.saveMessage(message);


        socket.emit('message_ack', {
          uuid: savedMessage.uuid,
          id: savedMessage.id,
          conversation_id: savedMessage.conversation_id,
          status: 'sent',
          created_at: savedMessage.created_at,
        });

        await messageService.updateConversationTimestamp(message.conversation_id);

        io.to(message.conversation_id).emit('receive_message', {
          ...savedMessage,
          created_at: savedMessage.created_at,
        });

        try {
          const recipients = await messageService.fetchConversationRecipients(
            message.conversation_id,
            message.user_id,
          );
          const senderName =
            (await messageService.fetchUserDisplayName(message.user_id)) ||
            String(message?.sender_name || '').trim() ||
            'New message';
          const pushBody = buildMessagePushBody(savedMessage);

          const encryptionKey =
            (await messageService.fetchConversationEncryptionKey(
              message.conversation_id,
            )) || '';

          // Notification Settings: skip users who muted SalaamBox or turned on Do Not Disturb.
          const allowedRecipients = notificationPrefs
            ? await notificationPrefs.filterAllowed(
                recipients.map(recipient => recipient.id),
                'salaambox',
              )
            : null;

          await Promise.all(
            recipients.map(async recipient => {
              if (allowedRecipients && !allowedRecipients.has(Number(recipient.id))) {
                return;
              }
              if (
                isUserActivelyViewingConversation(
                  recipient.id,
                  message.conversation_id,
                )
              ) {
                return;
              }

              await pushService.sendPushToToken(
                recipient.device_id,
                senderName,
                pushBody,
                {
                  type: 'chat_message',
                  conversation_id: String(message.conversation_id),
                  sender_id: String(message.user_id),
                  sender_name: senderName,
                  message_id: String(savedMessage.id),
                  message_type: String(savedMessage.message_type || 'text'),
                  encryption_key: String(encryptionKey),
                },
                {
                  channelId: 'promo-notifaiction',
                  clickAction: 'CHAT_MESSAGE_ACTION',
                  category: 'CHAT_MESSAGE',
                  apnsPushType: 'alert',
                },
              );
            }),
          );
        } catch (pushError) {
          console.error('Failed to send chat message push:', pushError);
        }
      } catch (error) {
        console.error('Failed to send message:', error);
        emitSocketError(socket, 'DB Error', {
          details: error,
          uuid: message?.uuid || null,
          conversation_id: message?.conversation_id || null,
        });
      }
    });

    socket.on('mark_message_delivered', async data => {
      const {messageId, conversationId, userId} = data;

      if (!messageId || !conversationId || !userId) {
        emitSocketError(socket, 'Missing messageId, userId, or conversationId');
        return;
      }

      try {
        await messageService.saveMessageStatus(messageId, userId, 'delivered');

        socket.emit('delivered_confirmation', {
          messageId,
          conversationId,
          userId,
          status: 'delivered',
        });

        const message = await messageService.fetchMessageSender(messageId);
        if (!message) return;

        const sender = getOnlineUser(message.sender_id);
        if (sender) {
          io.to(sender.socketId).emit('message_status_update', {
            messageId,
            conversationId,
            userId,
            status: 'delivered',
          });
        }

        io.to(conversationId).emit('message_status_update', {
          messageId,
          conversationId,
          userId,
          status: 'delivered',
        });
      } catch (error) {
        console.error('Failed to mark message as delivered:', error);
        emitSocketError(socket, 'Failed to mark message as delivered');
      }
    });

    socket.on('mark_message_read', async data => {
      const {messageId, conversationId, userId} = data;

      if (!messageId || !conversationId || !userId) {
        emitSocketError(socket, 'Missing messageId, userId, or conversationId');
        return;
      }

      try {
        const message = await messageService.fetchMessageSender(messageId);
        if (!message) {
          emitSocketError(socket, 'Message not found');
          return;
        }

        if (Number(message.sender_id) === Number(userId)) {
          console.log('Message sender and receiver are the same');
          return;
        }

        const isActivelyViewing = isUserActivelyViewingConversation(userId, conversationId);
        if (!isActivelyViewing) {
          console.log(`[mark_message_read] Blocked: User ${userId} is not actively viewing conversation ${conversationId}`);
        }

        await messageService.saveMessageStatus(messageId, userId, 'read', {
          isActivelyViewing,
        });

        if (!isActivelyViewing) return;

        socket.emit('read_confirmation', {
          messageId,
          conversationId,
          userId,
          status: 'read',
        });

        await messageService.updateConversationTimestamp(conversationId);

        const sender = getOnlineUser(message.sender_id);
        if (sender) {
          io.to(sender.socketId).emit('message_read', {
            messageId,
            conversationId,
            userId,
            status: 'read',
          });
        }

        io.to(conversationId).emit('message_status_update', {
          messageId,
          conversationId,
          userId,
          status: 'read',
        });
      } catch (error) {
        console.error('Failed to mark message as read:', error);
        emitSocketError(socket, 'Failed to mark message as read');
      }
    });

    socket.on('get_messages', async data => {
      const {conversation_id, limit = 50, offset = 0} = data;

      if (!conversation_id) {
        emitSocketError(socket, 'Missing conversation_id');
        return;
      }

      try {
        const messages = await messageService.fetchMessageHistory(
          conversation_id,
          limit,
          offset,
        );

        socket.emit('messages_history', {
          conversation_id,
          messages,
          hasMore: messages.length === Number(limit),
        });
      } catch (error) {
        console.error('Failed to fetch messages:', error);
        emitSocketError(socket, 'Failed to fetch messages');
      }
    });

    socket.on('typing_event_send', data => {
      socket.broadcast.to(data.room_id).emit('typing_event_receive', data);
    });

    socket.on('message_reaction', data => {
      const {messageId, conversationId, userId, reactionType} = data;
      if (!messageId || !conversationId) return;

      io.to(conversationId).emit('message_reaction_receive', {
        messageId,
        conversationId,
        userId,
        reactionType,
      });
    });

    socket.on('leave-room', roomId => {
      if (roomId === 0) return;

      socket.leave(roomId, error => {
        if (error) {
          console.error('Failed to leave room:', error);
        }
      });
    });

    socket.on('cleanup_my_calls', ({userId}) => {
      const cleanedCount = callService.cleanupUserCalls(userId, 'cleanup');

      socket.emit('calls_cleaned', {
        count: cleanedCount,
        userId,
      });
    });

    socket.on('debug_active_calls', () => {
      socket.emit('debug_active_calls_response', {
        count: socketState.activeCalls.size,
        calls: Array.from(socketState.activeCalls.entries()).map(
          ([callId, call]) => ({
            callId,
            participants: call.participants,
            status: call.status,
            age: Date.now() - call.start_time.getTime(),
          }),
        ),
      });
    });

    socket.on('qna_send_message', async data => {
      await qnaService.handleQnaSendMessage(data);
    });

    if (mashwaraService) {
      socket.on('mashwara_create_room', (data, callback) => {
        if (data && data.userId) {
          mashwaraUserId = data.userId;
          setOnlineUser(data.userId, socket.id);
        }
        mashwaraService.handleCreateRoom(socket, data, callback);
      });

      socket.on('mashwara_join_room', (data, callback) => {
        if (data && data.userId) {
          mashwaraUserId = data.userId;
          setOnlineUser(data.userId, socket.id);
        }
        mashwaraService.handleJoinRoom(socket, data, callback);
      });

      socket.on('mashwara_leave_room', data => {
        mashwaraService.handleLeaveRoom(socket, data);
      });

      socket.on('mashwara_toggle_media', data => {
        mashwaraService.handleToggleMedia(socket, data);
      });

      socket.on('mashwara_signal', data => {
        mashwaraService.handleSignal(socket, data);
      });

      socket.on('mashwara_end_session', data => {
        mashwaraService.handleEndSession(socket, data);
      });

      socket.on('mashwara_decline_call', data => {
        mashwaraService.handleDeclineCall(socket, data);
      });

      socket.on('mashwara_get_participants', (data, callback) => {
        mashwaraService.handleGetParticipants(socket, data, callback);
      });

      socket.on('mashwara_register_user', ({userId}) => {
        mashwaraUserId = userId;
        const normalizedUserId = setOnlineUser(userId, socket.id);
        if (normalizedUserId !== null) {
          emitOnlineUsers();
        }
      });
    }

    // ── Live Stream (mediasoup SFU) — all events are additive ─────────────
    if (liveStreamService) {
      // Track which userId this socket belongs to for live-stream cleanup
      let liveStreamUserId = null;

      socket.on('live_stream_create_room', (data, callback) => {
        if (data && data.userId) liveStreamUserId = data.userId;
        liveStreamService.handleCreateRoom(socket, data, callback);
      });

      socket.on('live_stream_join_room', (data, callback) => {
        if (data && data.userId) liveStreamUserId = data.userId;
        liveStreamService.handleJoinRoom(socket, data, callback);
      });

      socket.on('live_stream_leave_room', data => {
        liveStreamService.handleLeaveRoom(socket, data);
      });

      socket.on('live_stream_create_transport', (data, callback) => {
        liveStreamService.handleCreateTransport(socket, data, callback);
      });

      socket.on('live_stream_connect_transport', (data, callback) => {
        liveStreamService.handleConnectTransport(socket, data, callback);
      });

      socket.on('live_stream_produce', (data, callback) => {
        liveStreamService.handleProduce(socket, data, callback);
      });

      socket.on('live_stream_consume', (data, callback) => {
        liveStreamService.handleConsume(socket, data, callback);
      });

      socket.on('live_stream_resume_consumer', (data, callback) => {
        liveStreamService.handleResumeConsumer(socket, data, callback);
      });

      socket.on('live_stream_toggle_media', data => {
        liveStreamService.handleToggleMedia(socket, data);
      });

      socket.on('live_stream_raise_hand', data => {
        liveStreamService.handleRaiseHand(socket, data);
      });

      socket.on('live_stream_chat_message', data => {
        liveStreamService.handleChatMessage(socket, data);
      });

      socket.on('live_stream_kick_participant', data => {
        liveStreamService.handleKickParticipant(socket, data);
      });

      socket.on('live_stream_end_session', data => {
        liveStreamService.handleEndSession(socket, data);
      });

      socket.on('live_stream_get_participants', (data, callback) => {
        liveStreamService.handleGetParticipants(socket, data, callback);
      });

      socket.on('live_stream_decline_call', data => {
        liveStreamService.handleDeclineCall(socket, data);
      });

      socket.on('live_stream_signal', data => {
        liveStreamService.handleSignal(socket, data);
      });

      // Store userId on socket for disconnect cleanup
      socket.on('live_stream_register_user', ({userId}) => {
        liveStreamUserId = userId;
      });

      // Expose getter for disconnect handler below
      socket._liveStreamUserId = () => liveStreamUserId;
    }

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);

      const {
        disconnectedConnectedUserId,
        disconnectedOnlineUserId,
        disconnectedActiveConversationUserId,
      } =
        removeSocketReferences(socket.id);
      const affectedUserId =
        disconnectedOnlineUserId ??
        disconnectedConnectedUserId ??
        disconnectedActiveConversationUserId;

      if (affectedUserId !== null && affectedUserId !== undefined) {
        callService.cleanupUserCalls(affectedUserId, 'disconnect');
      }

      if (mashwaraService) {
        const resolvedMashwaraUserId = mashwaraUserId ?? affectedUserId;
        if (resolvedMashwaraUserId !== null && resolvedMashwaraUserId !== undefined) {
          mashwaraService.handleSocketDisconnect(socket, resolvedMashwaraUserId);
        }
      }

      // Clean up live-stream rooms on disconnect
      if (liveStreamService) {
        const lsUserId = typeof socket._liveStreamUserId === 'function'
          ? socket._liveStreamUserId()
          : affectedUserId;
        if (lsUserId !== null && lsUserId !== undefined) {
          liveStreamService.handleSocketDisconnect(socket, lsUserId);
        }
      }

      emitConnectedUsers();
      emitOnlineUsers();

      if (affectedUserId !== null && affectedUserId !== undefined) {
        socket.broadcast.emit('user_offline', {
          userId: affectedUserId,
          activeUser: getOnlineUsersPayload(),
        });
      }
    });
  });
}

module.exports = {
  registerSocketHandlers,
};
