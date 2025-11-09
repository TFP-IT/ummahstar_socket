const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = require('./ummahstar-d55c6-firebase-adminsdk-fbsvc-c99d00e887.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

require('dotenv').config();

app.use(cors());
app.use(express.json()); // Add JSON parsing middleware

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

/**
 * SQL connection
 */
var mysql = require('mysql');
var con = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

con.connect(function (err) {
    if (err) throw err;
    console.log('MySql Database Connected');
});

// In your server code, update the push notification:
async function sendPushToToken(token, title, body, data = {}) {
    if (!token) return console.log('⚠️ No FCM token provided');

    const message = {
        token,
        notification: { title, body },
        data: {
            ...Object.fromEntries(
                Object.entries(data).map(([k, v]) => [k, String(v)])
            ),
            // Add these for background call handling
            click_action: 'INCOMING_CALL_ACTION',
            priority: 'high',
            'content-available': '1',
            sound: 'default',
        },
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: 'calls',
                clickAction: 'INCOMING_CALL_ACTION',
            },
        },
        apns: {
            headers: {
                'apns-priority': '10',
                'apns-push-type': 'background',
                'apns-topic': 'com.ummahstar', // Your app bundle ID
            },
            payload: {
                aps: {
                    alert: { title, body },
                    sound: 'default',
                    category: 'INCOMING_CALL',
                    'content-available': 1,
                    'mutable-content': 1,
                },
            },
        },
    };

    try {
        const res = await admin.messaging().send(message);
        console.log('✅ Push sent:', res);
    } catch (err) {
        console.error('❌ Push send error:', err);
    }
}

let users = [];
let activeUser = [];
let activeCalls = new Map(); // Store active calls

const addUser = (user, socketId) => {
    const userId = user.id;

    // Remove existing user if already connected
    users = users.filter((u) => u.userId !== userId);
    users.push({ userId, socketId });
};

const removeUser = (socketId) => {
    users = users.filter((user) => user.socketId !== socketId);
};

const getUser = (userId) => {
    return users.find((user) => user.userId === userId);
};

const getActiveUser = (userId) => {
    return activeUser.find((user) => user.id === userId);
};

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Client-side code - Updated uploadFileViaSocket function
const uploadFileViaSocket = async (
    fileUri,
    fileName,
    fileType,
    messageType
) => {
    try {
        console.log('🚀 Starting upload for:', fileName);
        console.log('🚀 File URI:', fileUri);
        console.log('🚀 Message type:', messageType);

        // Clean the file URI - remove file:// prefix if present
        const cleanFileUri = fileUri.replace('file://', '');
        console.log('🚀 Clean file URI:', cleanFileUri);

        // Check if file exists
        const fileExists = await RNFS.exists(cleanFileUri);
        console.log('🚀 File exists:', fileExists);

        if (!fileExists) {
            throw new Error(`File does not exist: ${cleanFileUri}`);
        }

        // Read file as base64
        const fileData = await RNFS.readFile(cleanFileUri, 'base64');
        console.log(
            '🚀 File read successfully, size:',
            fileData.length,
            'characters'
        );

        const uploadPayload = {
            uuid: uuid.v4(),
            conversation_id,
            fileName,
            fileType,
            fileData,
            messageType,
        };

        console.log(
            '🚀 Sending upload payload with keys:',
            Object.keys(uploadPayload)
        );

        return new Promise((resolve, reject) => {
            let responseReceived = false;

            // Listen for upload response
            const responseHandler = (response) => {
                console.log('📥 Upload response received:', response);
                responseReceived = true;

                if (response.success) {
                    resolve(response.file_url);
                } else {
                    reject(new Error(response.error || 'Upload failed'));
                }
                socketData.off('file_uploaded', responseHandler);
            };

            socketData.on('file_uploaded', responseHandler);

            // Emit upload request
            console.log('📤 Emitting upload_file event');
            socketData.emit('upload_file', uploadPayload);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (!responseReceived) {
                    console.log('⏰ Upload timeout - no response received');
                    socketData.off('file_uploaded', responseHandler);
                    reject(
                        new Error('Upload timeout - server did not respond')
                    );
                }
            }, 30000);
        });
    } catch (error) {
        console.error('🚨 File upload error:', error);
        throw error;
    }
};

const saveMessage = (msg, callback) => {
    // console.log("💾 SaveMessage function called with:", msg);

    const {
        uuid,
        conversation_id,
        user_id,
        encrypted_content,
        iv,
        message_type = 'text',
        metadata = null,
        reply_to = null,
    } = msg;

    // Clean, single-line query to avoid any formatting issues
    const query = `INSERT INTO messages (uuid, conversation_id, user_id, encrypted_content, iv, message_type, metadata, reply_to, is_edited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`;

    con.query(
        query,
        [
            uuid,
            conversation_id,
            user_id,
            encrypted_content,
            iv,
            message_type,
            metadata,
            reply_to,
        ],
        (err, result) => {
            if (err) {
                console.error('❌ Database error:', err);
                return callback(err, null);
            }

            console.log('✅ Message saved successfully, ID:', result.insertId);
            callback(null, { id: result.insertId, ...msg });
        }
    );
};

// Helper function to save message status
const saveMessageStatus = (messageId, userId, status, callback) => {
    const query = `
    INSERT INTO message_status (message_id, user_id, status, status_at, created_at, updated_at)
    VALUES (?, ?, ?, NOW(), NOW(), NOW())
    ON DUPLICATE KEY UPDATE 
    status = VALUES(status), 
    status_at = VALUES(status_at), 
    updated_at = VALUES(updated_at)
  `;

    con.query(query, [messageId, userId, status], (err, result) => {
        if (err) {
            console.error('Error saving message status:', err);
            callback && callback(err);
            return;
        }
        callback && callback(null, result);
    });
};

// Helper function to get conversation participants
const getConversationParticipants = (conversationId, callback) => {
    const query = `
    SELECT user_id 
    FROM conversation_participants 
    WHERE conversation_id = ?
  `;

    con.query(query, [conversationId], (err, results) => {
        if (err) {
            callback(err, null);
            return;
        }
        callback(
            null,
            results.map((row) => row.user_id)
        );
    });
};

// Socket connection handling
io.on('connection', (socket) => {
    console.log('user connected', socket.id);

    socket.on("join_sawal_jawab_room", (data) => {
      socket.join(data);
      console.log(`user join: ${socket.id} || room id: ${data}`);
    });

    socket.on('join_room', ({ conversation_id, user_id }) => {
        socket.join(conversation_id);
        addUser(user_id, socket.id);
        console.log(`User ${user_id} joined conversation ${conversation_id}`);
    });

    socket.on('addUser', (user) => {
        addUser(user, socket.id);
        io.emit('getUsers', users);
    });

    /**
     * User online status
     */
    socket.on('get_online_user', (data) => {
        const userId = Number(data);
        const existingUserIndex = activeUser.findIndex(
            (user) => user.id === userId
        );
        console.log('data', data);

        if (existingUserIndex !== -1) {
            // Update existing user's socket ID
            activeUser[existingUserIndex].socketId = socket.id;
        } else {
            // Add new user
            activeUser.push({ id: userId, socketId: socket.id });
        }

        console.log('online user', { id: userId, socketId: socket.id });

        // Emit to all clients including sender
        io.emit('receive_online_user', {
            userInfo: { id: userId, socketId: socket.id },
            activeUser,
        });
    });

    // ===================== CALLING SYSTEM =====================
    // Initiate call
    // Initiate call - FIXED
    socket.on('initiate_call', (data) => {
        console.log('📞 Call initiated:', data);

        const {
            callId,
            callType,
            conversation_id,
            caller_id,
            recipient_id,
            caller_info,
        } = data;

        // Check if recipient is online
        const recipient = getActiveUser(recipient_id);

        // Clean up any old/stale calls for these users first
        const staleCallsToRemove = [];
        activeCalls.forEach((call, existingCallId) => {
            if (
                call.participants.includes(caller_id) ||
                call.participants.includes(recipient_id)
            ) {
                // Remove calls that are older than 2 minutes or have failed status
                const callAge = new Date() - call.start_time;
                if (
                    callAge > 120000 ||
                    call.status === 'failed' ||
                    call.status === 'declined'
                ) {
                    staleCallsToRemove.push(existingCallId);
                }
            }
        });

        staleCallsToRemove.forEach((staleCallId) => {
            console.log(`🧹 Cleaning up stale call: ${staleCallId}`);
            activeCalls.delete(staleCallId);
        });

        // Check if caller is already in a call
        const callerExistingCall = Array.from(activeCalls.values()).find(
            (call) =>
                call.participants.includes(caller_id) &&
                (call.status === 'active' || call.status === 'ringing')
        );

        if (callerExistingCall) {
            console.log(`❌ Caller ${caller_id} is already in a call`);
            socket.emit('call_failed', {
                callId,
                error: 'You are already in a call',
                reason: 'caller_busy',
            });
            return;
        }

        // Check if recipient is already in a call
        const recipientExistingCall = Array.from(activeCalls.values()).find(
            (call) =>
                call.participants.includes(recipient_id) &&
                (call.status === 'active' || call.status === 'ringing')
        );

        if (recipientExistingCall) {
            console.log(
                `❌ Recipient ${recipient_id} is busy in call: ${recipientExistingCall.callId} (status: ${recipientExistingCall.status})`
            );
            socket.emit('call_failed', {
                callId,
                error: 'User is busy',
                reason: 'user_busy',
            });
            return;
        }

        // Store call informationMediaBaseUrl
        const callInfo = {
            callId,
            callType,
            conversation_id,
            caller_id,
            recipient_id,
            participants: [caller_id, recipient_id],
            status: 'ringing',
            start_time: new Date(),
            caller_info,
        };

        activeCalls.set(callId, callInfo);
        console.log(`📞 Active calls count: ${activeCalls.size}`);

        // Emit to recipient or send push notification
        if (recipient) {
            // Recipient is online - send via socket
            io.to(recipient.socketId).emit('incoming_call', {
                callId,
                callType,
                conversation_id,
                caller_info,
                timestamp: new Date().toISOString(),
            });
            console.log(
                `📞 Call sent to online recipient ${recipient_id} (socket: ${recipient.socketId})`
            );
        } else {
            // Recipient is offline - send FCM push notification
            console.log(
                `🔕 Recipient ${recipient_id} offline, sending FCM push...`
            );

            con.query(
                'SELECT device_id, first_name, last_name FROM users WHERE id = ? LIMIT 1',
                [recipient_id],
                async (err, results) => {
                    if (err) {
                        console.error('❌ DB error fetching user:', err);
                        return;
                    }

                    if (results.length === 0) {
                        console.log(
                            `❌ No user found for recipient_id ${recipient_id}`
                        );
                        return;
                    }

                    const user = results[0];
                    const token = user.device_id;

                    // Get caller name from caller_info or database
                    const callerName = caller_info?.name || 'Someone';

                    const title =
                        callType === 'audio'
                            ? 'Incoming voice call'
                            : 'Incoming video call';
                    const body = `${callerName} is calling you`;

                    const payload = {
                        type: 'incoming_call',
                        callId,
                        callType,
                        conversation_id: conversation_id.toString(),
                        caller_id: caller_id.toString(),
                        caller_name: callerName,
                        timestamp: new Date().toISOString(),
                    };

                    await sendPushToToken(token, title, body, payload);
                    console.log(`📲 FCM push sent to ${recipient_id}`);
                }
            );
        }

        // Set timeout for unanswered call
        setTimeout(() => {
            const call = activeCalls.get(callId);
            if (call && call.status === 'ringing') {
                console.log(`⏰ Call ${callId} timeout - no answer`);

                // Notify caller about timeout
                socket.emit('call_failed', {
                    callId,
                    error: 'No answer',
                    reason: 'timeout',
                });

                // Notify recipient about missed call (if they're online now)
                const currentRecipient = getActiveUser(recipient_id);
                if (currentRecipient) {
                    io.to(currentRecipient.socketId).emit('call_missed', {
                        callId,
                        caller_info,
                    });
                }

                // Mark call as failed and remove from active calls
                call.status = 'failed';
                activeCalls.delete(callId);
            }
        }, 30000); // 30 seconds timeout
    });

    // Answer call - FIXED
    socket.on('answer_call', (data) => {
        console.log('📞 Call answered:', data);

        const { callId, conversation_id, recipient_id } = data;
        const call = activeCalls.get(callId);

        if (!call) {
            socket.emit('call_error', { error: 'Call not found' });
            return;
        }

        // Update call status
        call.status = 'active';
        call.answer_time = new Date();
        activeCalls.set(callId, call);

        // Get caller socket
        const caller = getActiveUser(call.caller_id);

        if (caller) {
            // Notify caller that call was answered
            io.to(caller.socketId).emit('call_answered', {
                callId,
                conversation_id,
                recipient_id,
                timestamp: new Date().toISOString(),
            });
        }

        console.log(`📞 Call ${callId} answered successfully`);
    });

    // Decline call - FIXED
    socket.on('decline_call', (data) => {
        console.log('📞 Call declined:', data);

        const { callId, conversation_id, recipient_id } = data;
        const call = activeCalls.get(callId);

        if (!call) {
            socket.emit('call_error', { error: 'Call not found' });
            return;
        }

        // Set status to declined before notifying
        call.status = 'declined';
        activeCalls.set(callId, call);

        // Get caller socket
        const caller = getActiveUser(call.caller_id);

        if (caller) {
            // Notify caller that call was declined
            io.to(caller.socketId).emit('call_declined', {
                callId,
                conversation_id,
                declined_by: recipient_id,
                timestamp: new Date().toISOString(),
            });
        }

        // Remove call from active calls
        activeCalls.delete(callId);
        console.log(`📞 Call ${callId} was declined`);
    });

    // End call
    socket.on('end_call', (data) => {
        console.log('📞 Call ended:', data);

        const { callId, conversation_id, user_id } = data;
        const call = activeCalls.get(callId);

        if (!call) {
            socket.emit('call_error', { error: 'Call not found' });
            return;
        }

        const endTime = new Date();
        const duration = call.answer_time
            ? Math.floor((endTime - call.answer_time) / 1000)
            : 0;

        // Get other participant
        const otherUserId = call.participants.find((id) => id !== user_id);
        const otherUser = getActiveUser(otherUserId);

        if (otherUser) {
            // Notify other participant that call ended
            io.to(otherUser.socketId).emit('call_ended', {
                callId,
                conversation_id,
                ended_by: user_id,
                duration,
                timestamp: endTime.toISOString(),
            });
        }

        // Remove call from active calls
        activeCalls.delete(callId);
        console.log(`📞 Call ${callId} ended, duration: ${duration}s`);
    });

    // WebRTC signaling for actual call connection - FIXED
    socket.on('webrtc_offer', (data) => {
        console.log('🔄 WebRTC offer received:', data);
        const { callId, offer, conversation_id, sender_id } = data;

        // Get the call to find the recipient
        const call = activeCalls.get(callId);
        if (!call) {
            console.log(`❌ Call ${callId} not found for WebRTC offer`);
            return;
        }

        // Find the recipient (the user who is not the sender)
        const recipientId = call.participants.find((id) => id !== sender_id);
        const recipient = getActiveUser(recipientId);

        if (recipient) {
            io.to(recipient.socketId).emit('webrtc_offer', {
                callId,
                offer,
                conversation_id,
                sender_id,
            });
            console.log(`🔄 WebRTC offer forwarded to ${recipientId}`);
        } else {
            console.log(
                `❌ Recipient ${recipientId} not found for WebRTC offer`
            );
        }
    });

    socket.on('webrtc_answer', (data) => {
        console.log('🔄 WebRTC answer received:', data);
        const { callId, answer, conversation_id, sender_id } = data;

        // Get the call to find the caller
        const call = activeCalls.get(callId);
        if (!call) {
            console.log(`❌ Call ${callId} not found for WebRTC answer`);
            return;
        }

        // Find the caller (the user who is not the sender)
        const callerId = call.participants.find((id) => id !== sender_id);
        const caller = getActiveUser(callerId);

        if (caller) {
            io.to(caller.socketId).emit('webrtc_answer', {
                callId,
                answer,
                conversation_id,
                sender_id,
            });
            console.log(`🔄 WebRTC answer forwarded to ${callerId}`);
        } else {
            console.log(`❌ Caller ${callerId} not found for WebRTC answer`);
        }
    });

    socket.on('webrtc_ice_candidate', (data) => {
        console.log('🔄 ICE candidate received:', data);
        const { callId, candidate, conversation_id, sender_id } = data;

        // Get the call to find the other participant
        const call = activeCalls.get(callId);
        if (!call) {
            console.log(`❌ Call ${callId} not found for ICE candidate`);
            return;
        }

        // Find the other participant (the user who is not the sender)
        const otherUserId = call.participants.find((id) => id !== sender_id);
        const otherUser = getActiveUser(otherUserId);

        if (otherUser) {
            io.to(otherUser.socketId).emit('webrtc_ice_candidate', {
                callId,
                candidate,
                conversation_id,
                sender_id,
            });
            console.log(`🔄 ICE candidate forwarded to ${otherUserId}`);
        } else {
            console.log(
                `❌ Other user ${otherUserId} not found for ICE candidate`
            );
        }
    });

    // Handle incoming call for the receiving user (add this event listener)
    socket.on('incoming_call_response', (data) => {
        console.log('📞 Incoming call response:', data);
        // This can be used for additional incoming call handling if needed
    });

    // Call status check (optional - for debugging)
    socket.on('get_call_status', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);

        socket.emit('call_status', {
            callId,
            call: call || null,
            exists: !!call,
        });
    });

    // Check call status
    socket.on('get_call_status', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);

        socket.emit('call_status_response', {
            callId,
            exists: !!call,
            status: call ? call.status : null,
            participants: call ? call.participants : [],
        });
    });

    // Socket handler for file upload
    socket.on('upload_file', async (uploadData) => {
        console.log('📁 File upload request received');
        console.log('📁 Data keys:', Object.keys(uploadData));
        console.log('📁 File name:', uploadData.fileName);
        console.log('📁 Message type:', uploadData.messageType);
        console.log('📁 Conversation ID:', uploadData.conversation_id);
        console.log(
            '📁 File data length:',
            uploadData.fileData ? uploadData.fileData.length : 'undefined'
        );

        try {
            const {
                uuid,
                conversation_id,
                fileName,
                fileType,
                fileData,
                messageType,
            } = uploadData;

            // Validate required fields
            if (!fileData || !fileName || !conversation_id) {
                console.log('❌ Missing required fields');
                socket.emit('file_uploaded', {
                    success: false,
                    error: 'Missing required fields',
                    received: {
                        hasFileData: !!fileData,
                        hasFileName: !!fileName,
                        hasConversationId: !!conversation_id,
                    },
                });
                return;
            }

            // Create uploads directory if it doesn't exist
            const uploadsDir = path.join(__dirname, 'uploads', messageType);
            console.log('📁 Creating directory:', uploadsDir);

            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
                console.log('📁 Directory created');
            }

            // Generate unique filename
            const fileExtension = path.extname(fileName);
            const uniqueFileName = `${uuidv4()}${fileExtension}`;
            const filePath = path.join(uploadsDir, uniqueFileName);

            console.log('📁 Writing file to:', filePath);
            console.log('📁 File data size:', fileData.length, 'characters');

            // Write base64 data to file
            fs.writeFileSync(filePath, fileData, 'base64');

            // Verify file was created
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                console.log(
                    '📁 File created successfully, size:',
                    stats.size,
                    'bytes'
                );
            } else {
                throw new Error('File was not created');
            }

            // Generate file URL (adjust this based on your server setup)
            const file_url = `uploads/${messageType}/${uniqueFileName}`;

            console.log('✅ File uploaded successfully:', file_url);

            // Send success response
            socket.emit('file_uploaded', {
                success: true,
                file_url: file_url,
                fileName: uniqueFileName,
                originalName: fileName,
            });
        } catch (error) {
            console.error('❌ File upload error:', error);
            console.error('❌ Error stack:', error.stack);
            socket.emit('file_uploaded', {
                success: false,
                error: error.message || 'File upload failed',
            });
        }
    });

    /**
     * SEND MESSAGE FUNCTIONALITY
     */
    socket.on('send_message', (msg) => {
        //console.log("📩 Message received:", msg);

        saveMessage(msg, (err, savedMsg) => {
            if (err) {
                console.error('❌ Error in saveMessage callback:', err);
                socket.emit('message_error', {
                    error: 'DB Error',
                    details: err,
                });
                return;
            }

            console.log(
                '✅ Message saved, emitting to room:',
                msg.conversation_id
            );

            // Update conversation timestamp for proper ordering
            const updateConversationQuery = `
          UPDATE conversations 
          SET updated_at = NOW() 
          WHERE id = ?
        `;

            con.query(updateConversationQuery, [msg.conversation_id], (err) => {
                if (err) {
                    console.error(
                        'Error updating conversation timestamp:',
                        err
                    );
                }
            });

            // Emit the message to all users in the conversation
            io.to(msg.conversation_id).emit('receive_message', {
                ...savedMsg,
                created_at: new Date().toISOString(),
            });
        });
    });

    /**
     * MESSAGE READ STATUS - Updated implementation
     */
    socket.on('mark_message_read', (data) => {
        const { messageId, conversationId, userId } = data;

        console.log('Marking message as read:', data);

        if (!messageId || !userId || !conversationId) {
            socket.emit('message_error', {
                error: 'Missing messageId, userId, or conversationId',
            });
            return;
        }

        // First, mark the message as read in database
        saveMessageStatus(messageId, userId, 'read', (err) => {
            if (err) {
                socket.emit('message_error', {
                    error: 'Failed to mark message as read',
                });
                return;
            }

            console.log(
                `Message ${messageId} marked as read by user ${userId}`
            );

            // Send immediate confirmation to the user who read the message
            socket.emit('read_confirmation', {
                messageId,
                conversationId,
                userId,
                status: 'read',
            });

            // Update the conversations table with read status
            const updateConversationQuery = `
      UPDATE conversations 
      SET updated_at = NOW() 
      WHERE id = ?
    `;

            con.query(updateConversationQuery, [conversationId], (err) => {
                if (err) {
                    console.error(
                        'Error updating conversation timestamp:',
                        err
                    );
                }
            });

            // Get message details to notify the sender
            const query = `
      SELECT user_id as sender_id, conversation_id 
      FROM messages 
      WHERE id = ?
    `;

            con.query(query, [messageId], (err, results) => {
                if (err || results.length === 0) {
                    console.error('Error getting message details:', err);
                    return;
                }

                const message = results[0];

                // Notify the message sender that their message was read
                const sender = activeUser.find(
                    (user) => user.id === message.sender_id
                );
                if (sender) {
                    io.to(sender.socketId).emit('message_read', {
                        messageId,
                        conversationId,
                        userId,
                        status: 'read',
                    });
                }

                // Broadcast read status to all participants in the conversation
                io.to(conversationId).emit('message_status_update', {
                    messageId,
                    conversationId,
                    userId,
                    status: 'read',
                });
            });
        });
    });

    /**
     * GET MESSAGE HISTORY
     */
    socket.on('get_messages', (data) => {
        const { conversation_id, limit = 50, offset = 0 } = data;

        if (!conversation_id) {
            socket.emit('message_error', {
                error: 'Missing conversation_id',
            });
            return;
        }

        // Updated query to get messages in DESC order (newest first for pagination)
        // but reverse them for display (oldest first in chat)
        const query = `
      SELECT m.*, 
             GROUP_CONCAT(CONCAT(ms.user_id, ':', ms.status) SEPARATOR ',') as message_statuses
      FROM messages m
      LEFT JOIN message_status ms ON m.id = ms.message_id
      WHERE m.conversation_id = ?
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `;

        con.query(query, [conversation_id, limit, offset], (err, results) => {
            if (err) {
                socket.emit('message_error', {
                    error: 'Failed to fetch messages',
                });
                return;
            }

            // Parse message statuses
            const messages = results
                .map((msg) => {
                    const statuses = {};
                    if (msg.message_statuses) {
                        msg.message_statuses
                            .split(',')
                            .forEach((statusPair) => {
                                const [userId, status] = statusPair.split(':');
                                statuses[userId] = status;
                            });
                    }

                    return {
                        ...msg,
                        statuses,
                        message_statuses: undefined, // Remove the raw string
                    };
                })
                .reverse(); // Reverse to get chronological order for chat display

            socket.emit('messages_history', {
                conversation_id,
                messages,
                hasMore: results.length === limit,
            });
        });
    });

    /**
     * Typing indicators
     */
    socket.on('typing_event_send', (data) => {
        socket.broadcast.to(data.room_id).emit('typing_event_receive', data);
        console.log('typing', data);
    });

    socket.on('leave-room', (roomId) => {
        if (roomId !== 0) {
            socket.leave(roomId, function (err) {
                if (err) console.log(err);
            });
        } else {
            console.log('load avoiding💥');
        }
    });

    /**
     * Handle disconnect
     */

    // Handle disconnect during call - INTEGRATED WITH YOUR EXISTING CODE
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        // Remove user from users array
        const disconnectedUser = users.find(
            (user) => user.socketId === socket.id
        );

        // ADDED: Clean up any active calls for this user BEFORE removing from users
        if (disconnectedUser) {
            console.log(
                '📞 Checking for active calls for disconnected user:',
                disconnectedUser.userId
            );

            // Find any active calls for this user
            const userActiveCalls = Array.from(activeCalls.entries()).filter(
                ([callId, call]) =>
                    call.participants.includes(disconnectedUser.userId)
            );

            userActiveCalls.forEach(([callId, call]) => {
                // Get other participant
                const otherUserId = call.participants.find(
                    (id) => id !== disconnectedUser.userId
                );
                const otherUser = getActiveUser(otherUserId);

                if (otherUser) {
                    // Notify other participant that call ended due to disconnect
                    io.to(otherUser.socketId).emit('call_ended', {
                        callId,
                        conversation_id: call.conversation_id,
                        ended_by: disconnectedUser.userId,
                        reason: 'disconnect',
                        timestamp: new Date().toISOString(),
                    });
                }

                // Remove call
                activeCalls.delete(callId);
                console.log(`📞 Call ${callId} ended due to user disconnect`);
            });

            if (userActiveCalls.length > 0) {
                console.log(
                    `📞 Cleaned up ${userActiveCalls.length} calls for disconnected user`
                );
            }
        }

        removeUser(socket.id);

        // Remove from active
        activeUser = activeUser.filter((star) => star.socketId !== socket.id);

        // Broadcast updated user list
        io.emit('getUsers', users);

        if (disconnectedUser) {
            socket.broadcast.emit('user_offline', {
                userId: disconnectedUser.userId,
                activeUser,
            });
        }
    });

    // Add helper function to clean up user calls on disconnect or explicit cleanup
    const cleanupUserCalls = (userId) => {
        const userCalls = Array.from(activeCalls.entries()).filter(
            ([callId, call]) => call.participants.includes(userId)
        );

        userCalls.forEach(([callId, call]) => {
            console.log(`🧹 Cleaning up call ${callId} for user ${userId}`);

            // Notify other participant if they exist
            const otherUserId = call.participants.find((id) => id !== userId);
            const otherUser = getActiveUser(otherUserId);

            if (otherUser) {
                io.to(otherUser.socketId).emit('call_ended', {
                    callId,
                    conversation_id: call.conversation_id,
                    ended_by: userId,
                    reason: 'cleanup',
                    timestamp: new Date().toISOString(),
                });
            }

            activeCalls.delete(callId);
        });

        return userCalls.length;
    };

    // Add explicit cleanup endpoint
    socket.on('cleanup_my_calls', (data) => {
        const { userId } = data;
        const cleanedCount = cleanupUserCalls(userId);
        console.log(
            `🧹 Manually cleaned ${cleanedCount} calls for user ${userId}`
        );

        socket.emit('calls_cleaned', {
            count: cleanedCount,
            userId,
        });
    });

    // Add a debug endpoint to check active calls (optional)
    socket.on('debug_active_calls', () => {
        console.log(
            '🐛 Active calls debug:',
            Array.from(activeCalls.entries()).map(([id, call]) => ({
                callId: id,
                participants: call.participants,
                status: call.status,
                duration: new Date() - call.start_time,
            }))
        );

        socket.emit('debug_active_calls_response', {
            count: activeCalls.size,
            calls: Array.from(activeCalls.entries()).map(([id, call]) => ({
                callId: id,
                participants: call.participants,
                status: call.status,
                age: new Date() - call.start_time,
            })),
        });
    });

    socket.on('qna_send_message', (data) => {
        socket.to(data.room_id).emit('qna_recive_message', data);
        console.log('qna message', data);

        const query = `
    INSERT INTO qna_messages (sender_id, qna_id, sender_name, room_id, msg_type, sender_image, media, text, time, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `;

        const updateQnaRemainingSeconds = `
    UPDATE qna_registrations SET remaining_seconds = remaining_seconds - ? WHERE qna_id = ? AND user_id = ?
  `;

        const values = [
            data.sender_id,
            data.qna_id,
            data.sender_name,
            data.room_id,
            data.msg_type,
            data.sender_image,
            data.media,
            data.text,
            data.time,
            1,
        ];

        con.query(query, values, function (err, res) {
            if (err) {
                console.error('Error executing query:', err);
                return;
            }

            if (res.affectedRows > 0) {
                console.log('qna message saved to database ❤️');

                // Update remaining seconds
                const updateValues = [
                    data.duration,
                    data.qna_id,
                    data.sender_id,
                ];
                !data?.is_star && con.query(
                    updateQnaRemainingSeconds,
                    updateValues,
                    function (err, res) {
                        if (err) {
                            console.error(
                                'Error updating remaining seconds:',
                                err
                            );
                            return;
                        }

                        if (res.affectedRows > 0) {
                            console.log(
                                'Remaining seconds updated successfully ❤️'
                            );
                        }
                    }
                );
            }
        });
    });
});

// Periodic global stale call cleanup (every 30 seconds)
setInterval(() => {
    const now = new Date();
    const staleCalls = [];

    activeCalls.forEach((call, callId) => {
        const callAge = now - call.start_time;
        if (
            callAge > 120000 || // 2 minutes
            (call.status !== 'active' && call.status !== 'ringing')
        ) {
            staleCalls.push(callId);
        }
    });

    staleCalls.forEach((callId) => {
        const call = activeCalls.get(callId);
        if (call) {
            console.log(
                `🧹 Periodic cleanup: Removing stale call ${callId} (status: ${
                    call.status
                }, age: ${now - call.start_time}ms)`
            );

            // Notify participants if still connected
            call.participants.forEach((userId) => {
                const user = getActiveUser(userId);
                if (user) {
                    io.to(user.socketId).emit('call_ended', {
                        callId,
                        conversation_id: call.conversation_id,
                        reason: 'stale_cleanup',
                        timestamp: now.toISOString(),
                    });
                }
            });

            activeCalls.delete(callId);
        }
    });

    if (staleCalls.length > 0) {
        console.log(
            `🧹 Periodic cleanup removed ${staleCalls.length} stale calls`
        );
    }
}, 30000); // Run every 30 seconds

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

server.listen(3005, () => {
    console.log('listening on http://localhost:3005');
});
