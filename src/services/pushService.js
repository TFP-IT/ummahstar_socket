function createPushService({admin, firebaseReady}) {
  function normalizeDataKey(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;

    const reservedKeys = new Set([
      'from',
      'gcm',
      'message_type',
      'notification',
      'collapse_key',
    ]);

    if (
      reservedKeys.has(normalizedKey) ||
      normalizedKey.startsWith('google.') ||
      normalizedKey.startsWith('gcm.')
    ) {
      return `custom_${normalizedKey.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    }

    return normalizedKey;
  }

  function normalizeDataPayload(data = {}) {
    return Object.fromEntries(
      Object.entries(data).reduce((entries, [key, value]) => {
        const normalizedKey = normalizeDataKey(key);
        if (!normalizedKey) return entries;

        entries.push([normalizedKey, String(value)]);
        return entries;
      }, []),
    );
  }

  async function sendPushToToken(token, title, body, data = {}, options = {}) {
    if (!firebaseReady) return;
    if (!token) {
      console.log('No FCM token found for push notification');
      return;
    }

    const clickAction = options.clickAction || 'INCOMING_CALL_ACTION';
    const channelId = options.channelId || 'calls';
    const category = options.category || 'INCOMING_CALL';
    const apnsPushType = options.apnsPushType || 'background';
    const apnsPriority = options.apnsPriority || '10';

    const message = {
      token,
      notification: {title, body},
      data: {
        ...normalizeDataPayload(data),
        click_action: clickAction,
        priority: 'high',
        'content-available': '1',
        sound: 'default',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId,
          clickAction,
        },
      },
      apns: {
        headers: {
          'apns-priority': apnsPriority,
          'apns-push-type': apnsPushType,
          'apns-topic': 'com.ummahstar',
        },
        payload: {
          aps: {
            alert: {title, body},
            sound: 'default',
            category,
            'content-available': 1,
            'mutable-content': 1,
          },
        },
      },
    };

    try {
      const response = await admin.messaging().send(message);
      console.log('Push sent successfully:', response);
    } catch (error) {
      console.error('Push send failed:', error);
    }
  }

  return {
    sendPushToToken,
  };
}

module.exports = {
  createPushService,
};
