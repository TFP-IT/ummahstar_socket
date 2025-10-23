const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

app.use(cors());
app.use(express.json()); // Add JSON parsing middleware

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

/**
 * SQL connection
 */
var mysql = require("mysql");
var con = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

con.connect(function (err) {
  if (err) throw err;
  console.log("MySql Database Connected");
});

let users = [];

const addUser = (user, socketId) => {
  const userId = user.id;
  
  // Remove existing user if already connected
  users = users.filter(u => u.userId !== userId);
  users.push({ userId, socketId });
};

const removeUser = (socketId) => {
  users = users.filter(user => user.socketId !== socketId);
};

const getUser = (userId) => {
  return users.find(user => user.userId === userId);
};

let activeUser = [];

const saveMessage = (msg, callback) => {
    // console.log("💾 SaveMessage function called with:", msg);
    
    const {
        uuid,
        conversation_id,
        user_id,
        encrypted_content,
        iv,
        message_type = "text",
        metadata = null,
        reply_to = null,
    } = msg;

    // Clean, single-line query to avoid any formatting issues
    const query = `INSERT INTO messages (uuid, conversation_id, user_id, encrypted_content, iv, message_type, metadata, reply_to, is_edited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`;

    // console.log("💾 Executing query with parameters:");
    // console.log("💾 uuid:", uuid, typeof uuid);
    // console.log("💾 conversation_id:", conversation_id, typeof conversation_id);
    // console.log("💾 user_id:", user_id, typeof user_id);

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
                console.error("❌ Database error:", err);
                return callback(err, null);
            }

            console.log("✅ Message saved successfully, ID:", result.insertId);
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
    callback(null, results.map(row => row.user_id));
  });
};

// Socket connection handling
io.on("connection", (socket) => {
  console.log("user connected", socket.id);

  // socket.on("join_room", (data) => {
  //   socket.join(data);
  //   console.log(`user join: ${socket.id} || room id: ${data}`);
  // });

  socket.on("join_room", ({ conversation_id, user_id }) => {
    socket.join(conversation_id);
    addUser(user_id, socket.id);
    console.log(`User ${user_id} joined conversation ${conversation_id}`);
  });



  socket.on("addUser", (user) => {
    addUser(user, socket.id);
    io.emit("getUsers", users);
  });

  /**
   * User online status
   */
  socket.on("get_online_user", (data) => {
    const userId = Number(data);
    const existingUserIndex = activeUser.findIndex(user => user.id === userId);
    console.log('data', data)
    
    if (existingUserIndex !== -1) {
      // Update existing user's socket ID
      activeUser[existingUserIndex].socketId = socket.id;
    } else {
      // Add new user
      activeUser.push({ id: userId, socketId: socket.id });
    }
    
    console.log("online user", { id: userId, socketId: socket.id });
    
    // Emit to all clients including sender
    io.emit("receive_online_user", {
      userInfo: { id: userId, socketId: socket.id },
      activeUser,
    });
  });

  /**
   * SEND MESSAGE FUNCTIONALITY
   */
socket.on("send_message", (msg) => {
    //console.log("📩 Message received:", msg);
    
    saveMessage(msg, (err, savedMsg) => {
        
        if (err) {
            console.error("❌ Error in saveMessage callback:", err);
            socket.emit("message_error", { error: "DB Error", details: err });
            return;
        }

        console.log("✅ Message saved, emitting to room:", msg.conversation_id);
        io.to(msg.conversation_id).emit("receive_message", savedMsg);
    });
    
});

  /**
   * MESSAGE READ STATUS
   */
  socket.on("mark_message_read", (data) => {
    const { messageId, userId } = data;
    
    if (!messageId || !userId) {
      socket.emit("message_error", {
        error: "Missing messageId or userId"
      });
      return;
    }

    saveMessageStatus(messageId, userId, 'read', (err) => {
      if (err) {
        socket.emit("message_error", {
          error: "Failed to mark message as read"
        });
        return;
      }

      // Get message details to notify sender
      const query = `
        SELECT sender_id, conversation_id 
        FROM messages 
        WHERE id = ?
      `;
      
      con.query(query, [messageId], (err, results) => {
        if (err || results.length === 0) {
          console.error("Error getting message details:", err);
          return;
        }

        const message = results[0];
        
        // Notify sender that message was read
        const sender = getUser(message.sender_id);
        if (sender) {
          io.to(sender.socketId).emit("message_read", {
            messageId,
            userId,
            status: 'read'
          });
        }

        // Broadcast to conversation room
        socket.to(message.conversation_id).emit("message_status_update", {
          messageId,
          userId,
          status: 'read'
        });
      });
    });
  });

  /**
   * GET MESSAGE HISTORY
   */
  socket.on("get_messages", (data) => {
    const { conversation_id, limit = 50, offset = 0 } = data;
    
    if (!conversation_id) {
      socket.emit("message_error", {
        error: "Missing conversation_id"
      });
      return;
    }

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
        socket.emit("message_error", {
          error: "Failed to fetch messages"
        });
        return;
      }

      // Parse message statuses
      const messages = results.map(msg => {
        const statuses = {};
        if (msg.message_statuses) {
          msg.message_statuses.split(',').forEach(statusPair => {
            const [userId, status] = statusPair.split(':');
            statuses[userId] = status;
          });
        }
        
        return {
          ...msg,
          statuses,
          message_statuses: undefined // Remove the raw string
        };
      }).reverse(); // Reverse to get chronological order

      socket.emit("messages_history", {
        conversation_id,
        messages,
        hasMore: results.length === limit
      });
    });
  });

  /**
   * Typing indicators
   */
  socket.on("typing_event_send", (data) => {
    socket.broadcast.to(data.room_id).emit("typing_event_receive", data);
    console.log("typing", data);
  });

  socket.on("leave-room", (roomId) => {
    if (roomId !== 0) {
      socket.leave(roomId, function (err) {
        if (err) console.log(err);
      });
    } else {
      console.log("load avoiding💥");
    }
  });

  /**
   * Handle disconnect
   */
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    
    // Remove user from users array
    const disconnectedUser = users.find(user => user.socketId === socket.id);
    removeUser(socket.id);
    
    // Remove from active
    activeUser = activeUser.filter(star => star.socketId !== socket.id);
    
    // Broadcast updated user list
    io.emit("getUsers", users);
    
    if (disconnectedUser) {
      socket.broadcast.emit("user_offline", {
        userId: disconnectedUser.userId,
        activeUser
      });
    }
  });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});


server.listen(3005, () => {
  console.log("listening on http://localhost:3005");
});
