const moment = require('moment');

function createHalaqaCronService({ queryDb, pushService, reminderMinutes = [10, 5, 1] }) {
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
      const dateStr = now.format('YYYY-MM-DD');
      const tomorrowStr = moment(now).add(1, 'day').format('YYYY-MM-DD');

      // Dynamic Time-Window bounds based on configured reminderMinutes
      const maxReminderMin = Math.max(...reminderMinutes, 0);
      const minReminderMin = Math.min(...reminderMinutes, 0);
      const upperBoundWindow = maxReminderMin + 3;
      const lowerBoundWindow = minReminderMin - 3;

      console.log(`[HalaqaCron DEBUG] Running check at ${now.format('YYYY-MM-DD HH:mm:ss')} for dates ${dateStr}% and ${tomorrowStr}% (Time-Window: ${lowerBoundWindow}m to +${upperBoundWindow}m)`);

      // 1. Query Meetup Events for today and tomorrow
      const meetupQuery = `
        SELECT m.id, m.title, m.event_date, m.start_time, m.star_id as host_id
        FROM meetup_events m
        WHERE (m.event_date LIKE ? OR m.event_date LIKE ?)
      `;

      const meetups = await queryDb(meetupQuery, [
        `${dateStr}%`,
        `${tomorrowStr}%`,
      ]).catch(err => {
        console.error('[HalaqaCron] Error fetching meetups:', err);
        return [];
      });

      console.log(`[HalaqaCron DEBUG] Found ${Array.isArray(meetups) ? meetups.length : 0} candidate events from DB`);

      if (Array.isArray(meetups) && meetups.length > 0) {
        for (const event of meetups) {
          const rawStart = String(event.start_time || '').trim();
          if (!rawStart) continue;

          // Extract YYYY-MM-DD date using regex to avoid timezone conversion issues
          let eventDateStr = dateStr;
          if (event.event_date) {
            const rawDateStr = String(event.event_date).trim();
            const match = rawDateStr.match(/\d{4}-\d{2}-\d{2}/);
            if (match) {
              eventDateStr = match[0];
            }
          }

          const startMoment = moment(`${eventDateStr} ${rawStart}`, [
            'YYYY-MM-DD HH:mm:ss',
            'YYYY-MM-DD HH:mm',
            'YYYY-MM-DD h:mm:ss A',
            'YYYY-MM-DD h:mm A',
            'YYYY-MM-DD hh:mm:ss A',
            'YYYY-MM-DD hh:mm A',
            'YYYY-MM-DD H:mm:ss',
            'YYYY-MM-DD H:mm',
          ]);
          if (!startMoment.isValid()) continue;

          const diffMinutes = Math.round(startMoment.diff(now, 'minutes', true));

          // ALGORITHM 1: Time-Window Filtering Optimization
          // Instantly skip events outside the active reminder window [lowerBoundWindow ... upperBoundWindow]
          if (diffMinutes < lowerBoundWindow || diffMinutes > upperBoundWindow) {
            continue;
          }

          console.log(`[HalaqaCron DEBUG] Event ${event.id} ("${event.title}") in active window: diffMinutes=${diffMinutes}`);

          for (const targetMin of reminderMinutes) {
            // Trigger if event starts in approximately targetMin minutes (+/- 2 mins window)
            if (diffMinutes >= targetMin - 2 && diffMinutes <= targetMin + 2) {
              console.log(`[HalaqaCron 🎯 MATCH!] Event ${event.id} ("${event.title}") is ~${diffMinutes}m away (matches ${targetMin}m target). Processing notifications...`);
              await processEventParticipants('meetup', event, targetMin);
            }
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
    const hostId = event.host_id;

    try {
      const userTokens = new Map(); // userId -> device_id

      // 1. Get host user's token if available
      if (hostId) {
        const hostRows = await queryDb(
          `SELECT id as user_id, device_id FROM users WHERE id = ?`,
          [hostId]
        ).catch(err => {
          console.error(`[HalaqaCron DEBUG] Host lookup error for host ${hostId}:`, err);
          return [];
        });
        if (Array.isArray(hostRows) && hostRows.length > 0 && hostRows[0].device_id) {
          console.log(`[HalaqaCron DEBUG] Found FCM token for Host ID ${hostId}`);
          userTokens.set(hostRows[0].user_id, hostRows[0].device_id);
        } else {
          console.log(`[HalaqaCron DEBUG] Host ID ${hostId} has no device_id in users table.`);
        }
      }

      // 2. Query registered users from meetup_event_registrations
      const regRows = await queryDb(
        `SELECT p.user_id, u.device_id 
         FROM meetup_event_registrations p 
         JOIN users u ON p.user_id = u.id 
         WHERE p.meetup_event_id = ?`,
        [eventId]
      ).catch(err => {
        console.error(`[HalaqaCron DEBUG] Error querying meetup_event_registrations for event ${eventId}:`, err);
        return [];
      });

      if (Array.isArray(regRows)) {
        for (const r of regRows) {
          if (r.user_id && r.device_id) {
            userTokens.set(r.user_id, r.device_id);
          }
        }
        console.log(`[HalaqaCron DEBUG] meetup_event_registrations: found ${regRows.length} registered users`);
      }

      if (userTokens.size === 0) {
        console.log(`[HalaqaCron DEBUG] No participants or host found with FCM token for event ${eventId} ("${title}")`);
        return;
      }

      console.log(`[HalaqaCron DEBUG] Sending ${minutesBefore}m push to ${userTokens.size} user(s)...`);

      for (const [userId, token] of userTokens.entries()) {
        const dedupeKey = `${eventType}_${eventId}_${userId}_${minutesBefore}`;
        if (sentNotifications.has(dedupeKey)) {
          console.log(`[HalaqaCron DEBUG] Dedupe hit: Key "${dedupeKey}" already sent to user ${userId}. Skipping.`);
          continue;
        }

        sentNotifications.add(dedupeKey);

        const pushTitle = 'Live Halaqa Starting Soon!';
        const pushBody = `"${title}" will start in ${minutesBefore} minutes. Get ready to join!`;
        const pushData = {
          type: 'halaqa_reminder',
          eventId: String(eventId),
          eventType,
          minutesBefore: String(minutesBefore),
        };

        console.log(`[HalaqaCron 🚀 PUSH SENT] Sending FCM push (${minutesBefore}m reminder) to user ${userId} for event "${title}"`);
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
