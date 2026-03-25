function createPushService({admin, firebaseReady}) {
  async function sendPushToToken(token, title, body, data = {}) {
    if (!firebaseReady) return;
    if (!token) {
      console.log('No FCM token found for push notification');
      return;
    }

    const message = {
      token,
      notification: {title, body},
      data: {
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)]),
        ),
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
          'apns-topic': 'com.ummahstar',
        },
        payload: {
          aps: {
            alert: {title, body},
            sound: 'default',
            category: 'INCOMING_CALL',
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
