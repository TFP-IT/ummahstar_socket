const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const {Server} = require('socket.io');

require('dotenv').config();

const {PORT} = require('./src/config/constants');
const {initializeFirebase} = require('./src/config/firebase');
const {createDbConnection, connectDb, createQueryDb} = require('./src/config/database');
const {createSocketState} = require('./src/state/socketState');
const {createPushService} = require('./src/services/pushService');
const {createMessageService} = require('./src/services/messageService');
const {createUploadService} = require('./src/services/uploadService');
const {createCallService} = require('./src/features/calls/callService');
const {createQnaService} = require('./src/features/qna/qnaService');
const {createMashwaraService} = require('./src/features/mashwara/mashwaraService');
const {createMashwaraState} = require('./src/features/mashwara/mashwaraState');
const {createLiveStreamService, createWorkers} = require('./src/features/liveStream/liveStreamService');
const {createLiveStreamState} = require('./src/features/liveStream/liveStreamState');
const {registerSocketHandlers} = require('./src/socket/registerSocketHandlers');
const {createTokenVerifier, createAuthMiddleware, AUTH_MODE} = require('./src/socket/socketAuth');
const {createHalaqaCronService} = require('./src/services/halaqaCronService');
const {createMashwaraCronService} = require('./src/services/mashwaraCronService');
const {createNotificationPrefsService} = require('./src/services/notificationPrefsService');


const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({limit: '100mb'}));
app.use(express.urlencoded({limit: '100mb', extended: true}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 100e6, // 100MB — allows large file uploads
});

const db = createDbConnection(process.env);
connectDb(db);

const queryDb = createQueryDb(db);
const verifyToken = createTokenVerifier(queryDb);
io.use(createAuthMiddleware(verifyToken));
console.log(`[socketAuth] mode: ${AUTH_MODE}`);
const socketState = createSocketState();
const firebase = initializeFirebase(__dirname);

const services = {
  pushService: createPushService(firebase),
  notificationPrefs: createNotificationPrefsService({queryDb}),
  uploadService: createUploadService({baseDir: __dirname}),
  messageService: createMessageService({queryDb}),
  callService: null,
  qnaService: createQnaService({queryDb, io}),
  halaqaCronService: null,
  mashwaraCronService: null,
};

services.halaqaCronService = createHalaqaCronService({
  queryDb,
  pushService: services.pushService,
  notificationPrefs: services.notificationPrefs,
});

services.mashwaraCronService = createMashwaraCronService({
  queryDb,
  pushService: services.pushService,
  notificationPrefs: services.notificationPrefs,
  io,
  socketState,
  reminderMinutes: [10, 5, 1, 0],
  checkIntervalMs: 30 * 1000,
});

services.callService = createCallService({
  io,
  queryDb,
  socketState,
  pushService: services.pushService,
  messageService: services.messageService,
});

const mashwaraState = createMashwaraState();
services.mashwaraState = mashwaraState;
services.mashwaraService = createMashwaraService({
  io,
  mashwaraState,
  socketState,
  pushService: services.pushService,
  queryDb,
});

// Boot mediasoup workers + live stream service (async — non-blocking startup)
createWorkers().then(() => {
  const liveStreamState = createLiveStreamState();
  services.liveStreamService = createLiveStreamService({
    io, 
    liveStreamState,
    socketState,
    pushService: services.pushService,
    queryDb
  });
  // console.log('[LiveStream] mediasoup SFU ready');
}).catch(err => {
  console.error('[LiveStream] Failed to start mediasoup workers:', err);
  // Server continues without live-stream; existing features unaffected
  services.liveStreamService = null;
});

registerSocketHandlers({
  io,
  socketState,
  services,
  verifyToken,
  queryDb,
});



app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/media/presigned-url', async (req, res) => {
  // Logged-in users only (Sanctum token in the Authorization header).
  const userId = await verifyToken(req.headers.authorization).catch(() => null);
  if (!userId) {
    return res.status(401).json({success: false, error: 'Unauthorized'});
  }
  try {
    const {fileName, messageType, fileType, uuid} = req.body;
    const result = await services.uploadService.generatePresignedUploadUrl({
      fileName,
      messageType,
      fileType,
      uuid,
    });
    res.json({success: true, ...result});
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

server.listen(PORT, () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
