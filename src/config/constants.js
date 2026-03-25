const path = require('path');

const PORT = Number(process.env.PORT || 3005);
const CALL_TIMEOUT_MS = 30 * 1000;
const STALE_CALL_MS = 2 * 60 * 1000;
const STALE_CALL_CLEANUP_INTERVAL_MS = 30 * 1000;
const SERVICE_ACCOUNT_PATTERN =
  /^ummahstar-d55c6-firebase-adminsdk-fbsvc-.*\.json$/;

module.exports = {
  PORT,
  CALL_TIMEOUT_MS,
  STALE_CALL_MS,
  STALE_CALL_CLEANUP_INTERVAL_MS,
  SERVICE_ACCOUNT_PATTERN,
  UPLOADS_DIR_NAME: 'uploads',
  INDEX_HTML_PATH: path.join(process.cwd(), 'index.html'),
};
