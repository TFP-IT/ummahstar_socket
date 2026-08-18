const moment = require('moment');

function createHalaqaCronService({ queryDb, pushService }) {
  if (!queryDb || !pushService) {
    console.warn('[HalaqaCron] queryDb or pushService missing. Cron disabled.');
    return { stop: () => {} };
  }

  // Set to track already sent notifications in memory: format `event_{type}_{id}_{userId}_{min}`
  const sentNotifications = new Set();

  // Cleanup old entries from sentNotifications every 2 hours to keep memory footprint low
  setInterval(() => {
    if (sentNotifications.size > 5000) {
      sentNotifications.clear();
    }
  }, 2 * 60 * 60 * 1000);

  async function checkAndSendReminders() {
    try {
      const now = moment();
      // Target window: events starting in ~15 minutes (between 13 and 17 minutes from now)
      const dateStr = now.format('YYYY-MM-DD');

      // 1. Query Meetup Events
      const meetupQuery = `
        SELECT m.id, m.title, m.event_date, m.start_time, m.user_id as host_id
        FROM meetup_events m
        WHERE (m.event_date = ? OR m.event_date LIKE ?)
          AND m.status = '1'
      `;

      const meetups = await queryDb(meetupQuery, [dateStr, `${dateStr}%`]).catch(err => {
        // Table or query fallback gracefully
        return [];
      });

      if (Array.isArray(meetups)) {
        for (const event of meetups) {
          const rawStart = String(event.start_time || '').trim();
          if (!rawStart) continue;

          const startMoment = moment(`${dateStr} ${rawStart}`, ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD h:mm A']);
          if (!startMoment.isValid()) continue;

          const diffMinutes = startMoment.diff(now, 'minutes');

          // Send reminder if event starts in approximately 15 minutes (13-17 mins range)
          if (diffMinutes >= 13 && diffMinutes <= 17) {
            await processEventParticipants('meetup', event, 15);
          }
        }
      }
    } catch (err) {
      console.error('[HalaqaCron] Error in checkAndSendReminders:', err);
    }
  }

  async function processEventParticipants(eventType, event, minutesBefore) {
    const eventId = event.id;
    const title = event.title || event.name || 'Live Halaqa';

    try {
      // Query registered users from meetup_event_registrations with FCM token in device_id
      const rows = await queryDb(
        `SELECT p.user_id, u.device_id FROM meetup_event_registrations p JOIN users u ON p.user_id = u.id WHERE p.meetup_event_id = ? OR p.event_id = ?`,
        [eventId, eventId]
      ).catch(() => null);

      if (!Array.isArray(rows) || rows.length === 0) return;

      for (const row of rows) {
        const userId = row.user_id;
        const token = row.device_id;
        if (!token) continue;

        const dedupeKey = `${eventType}_${eventId}_${userId}_${minutesBefore}`;
        if (sentNotifications.has(dedupeKey)) continue;

        sentNotifications.add(dedupeKey);

        const pushTitle = 'Live Halaqa Starting Soon!';
        const pushBody = `"${title}" will start in ${minutesBefore} minutes. Get ready to join!`;
        const pushData = {
          type: 'halaqa_reminder',
          eventId: String(eventId),
          eventType,
          minutesBefore: String(minutesBefore),
        };

        console.log(`[HalaqaCron] Sending FCM push to user ${userId} for event "${title}"`);
        await pushService.sendPushToToken(token, pushTitle, pushBody, pushData, {
          channelId: 'default',
        });
      }
    } catch (err) {
      console.error(`[HalaqaCron] Failed processing participants for ${eventType} event ${eventId}:`, err);
    }
  }

  // Run check every 60 seconds
  const intervalId = setInterval(checkAndSendReminders, 60 * 1000);
  console.log('[HalaqaCron] Server-side event reminder cron initialized (checking every 60s)');

  // Run first check immediately on boot
  checkAndSendReminders();

  return {
    stop: () => clearInterval(intervalId),
    checkAndSendReminders,
  };
}

module.exports = {
  createHalaqaCronService,
};
