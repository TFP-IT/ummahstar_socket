const crypto = require('crypto');

/**
 * Socket authentication backed by the Laravel Sanctum token table.
 *
 * A Sanctum plain-text token looks like "<id>|<secret>" and the
 * `personal_access_tokens.token` column stores sha256(<secret>).
 *
 * SOCKET_AUTH_MODE:
 *  - "compat" (default): sockets that authenticate get their identity
 *    enforced (client-supplied user ids are replaced by the verified id).
 *    Sockets that never authenticate still work as before, so app versions
 *    released before this change keep working.
 *  - "enforce": identity-bearing events from unauthenticated sockets are
 *    rejected. Switch to this once every client sends its token.
 */
const AUTH_MODE = String(process.env.SOCKET_AUTH_MODE || 'compat').toLowerCase();
const isEnforceMode = () => AUTH_MODE === 'enforce';

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map(); // rawToken -> {userId, expiresAt}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeRawToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^Bearer\s+/i, '');
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
  return trimmed;
}

function createTokenVerifier(queryDb) {
  return async function verifyToken(rawInput) {
    const raw = normalizeRawToken(rawInput);
    if (!raw) return null;

    const cached = tokenCache.get(raw);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.userId;
    }

    let rows;
    const sep = raw.indexOf('|');
    if (sep > 0) {
      const id = raw.slice(0, sep);
      const secret = raw.slice(sep + 1);
      if (!/^\d+$/.test(id) || !secret) return null;
      rows = await queryDb(
        'SELECT * FROM personal_access_tokens WHERE id = ? LIMIT 1',
        [id],
      );
      const row = rows && rows[0];
      if (!row || !safeEqualHex(row.token, sha256Hex(secret))) return null;
      rows = [row];
    } else {
      rows = await queryDb(
        'SELECT * FROM personal_access_tokens WHERE token = ? LIMIT 1',
        [sha256Hex(raw)],
      );
    }

    const row = rows && rows[0];
    if (!row) return null;
    if (row.tokenable_type && !/User$/.test(String(row.tokenable_type))) {
      return null;
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    const userId = Number(row.tokenable_id);
    if (!Number.isFinite(userId) || userId <= 0) return null;

    tokenCache.set(raw, {userId, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS});
    return userId;
  };
}

function extractHandshakeToken(socket) {
  const hs = socket.handshake || {};
  return (
    (hs.auth && hs.auth.token) ||
    (hs.headers && hs.headers.authorization) ||
    (hs.query && hs.query.token) ||
    null
  );
}

/**
 * io.use() middleware: authenticates from the handshake when a token is sent.
 * Never rejects the connection itself (a logged-out app still connects); the
 * per-event guards decide what an unauthenticated socket may do.
 */
function createAuthMiddleware(verifyToken) {
  return async (socket, next) => {
    socket.data = socket.data || {};
    try {
      const userId = await verifyToken(extractHandshakeToken(socket));
      if (userId) {
        socket.data.userId = userId;
      }
    } catch (error) {
      console.error('[socketAuth] handshake verification failed:', error.message);
    }
    next();
  };
}

/** Returns a copy of `data` with every listed field set to the verified id. */
function withVerifiedIdentity(data, userId, fields) {
  if (!fields || fields.length === 0) return data;
  if (fields.includes('__self__')) {
    // Payload is the user itself (an id or a {id, ...} object).
    if (data && typeof data === 'object') {
      return {...data, id: userId};
    }
    return userId;
  }
  const copy = data && typeof data === 'object' ? {...data} : {};
  fields.forEach(field => {
    copy[field] = userId;
  });
  return copy;
}

module.exports = {
  createTokenVerifier,
  createAuthMiddleware,
  withVerifiedIdentity,
  isEnforceMode,
  AUTH_MODE,
};
