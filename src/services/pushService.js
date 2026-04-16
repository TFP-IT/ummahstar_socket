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

    const isIncomingCall = data.type === 'incoming_call';

    const message = {
      token,
      data: {
        ...normalizeDataPayload(data),
        click_action: clickAction,
        priority: 'high',
        'content-available': '1',
      },
      android: {
        priority: 'high',
        ttl: 0, // Deliver immediately
      },
      apns: {
        headers: {
          'apns-priority': apnsPriority,
          'apns-push-type': apnsPushType,
          'apns-topic': 'com.ummahstar',
        },
        payload: {
          aps: {
            category,
            'content-available': 1,
            'mutable-content': 1,
          },
        },
      },
    };

    // Only add notification block if NOT an incoming call
    // Data-only messages wake up the app's background handler on Android more reliably for calls
    if (!isIncomingCall) {
      message.notification = {title, body};
      message.android.notification = {
        sound: 'default',
        channelId,
        clickAction,
      };
      message.apns.payload.aps.alert = {title, body};
      message.apns.payload.aps.sound = 'default';
      message.data.sound = 'default';
    } else {
      // For calls, set specific high priority flags
      message.android.ttl = 0; // Deliver immediately
    }

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
