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
const {registerSocketHandlers} = require('./src/socket/registerSocketHandlers');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const db = createDbConnection(process.env);
connectDb(db);

const queryDb = createQueryDb(db);
const socketState = createSocketState();
const firebase = initializeFirebase(__dirname);

const services = {
  pushService: createPushService(firebase),
  uploadService: createUploadService({baseDir: __dirname}),
  messageService: createMessageService({queryDb}),
  callService: null,
  qnaService: createQnaService({queryDb, io}),
};

services.callService = createCallService({
  io,
  queryDb,
  socketState,
  pushService: services.pushService,
});

registerSocketHandlers({
  io,
  socketState,
  services,
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
