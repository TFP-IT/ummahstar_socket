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
    return rawContent.length > 120 ? `${rawContent.slice(0, 117)}...` : rawContent;
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

function registerSocketHandlers({io, socketState, services}) {
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
    messageService,
    uploadService,
    qnaService,
    pushService,
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

  io.on('connection', socket => {
    console.log(`Socket connected: ${socket.id}`);

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

    socket.on('upload_file', uploadData => {
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

        const uploadedFile = uploadService.saveBase64File({
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
        });
      } catch (error) {
        console.error('File upload failed:', error);
        socket.emit('file_uploaded', {
          success: false,
          error: error.message || 'File upload failed',
        });
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
          created_at: new Date().toISOString(),
        });

        await messageService.updateConversationTimestamp(message.conversation_id);

        io.to(message.conversation_id).emit('receive_message', {
          ...savedMessage,
          created_at: new Date().toISOString(),
        });

        try {
          const recipients = await messageService.fetchConversationRecipients(
            message.conversation_id,
            message.user_id,
          );
          const senderName =
            String(message?.sender_name || '').trim() || 'New message';
          const pushBody = buildMessagePushBody(savedMessage);

          await Promise.all(
            recipients.map(async recipient => {
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
                  conversation_id: message.conversation_id,
                  sender_id: message.user_id,
                  sender_name: senderName,
                  message_id: savedMessage.id,
                  message_type: savedMessage.message_type,
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
        await messageService.saveMessageStatus(messageId, userId, 'read');

        socket.emit('read_confirmation', {
          messageId,
          conversationId,
          userId,
          status: 'read',
        });

        await messageService.updateConversationTimestamp(conversationId);

        const message = await messageService.fetchMessageSender(messageId);
        if (!message) return;

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
