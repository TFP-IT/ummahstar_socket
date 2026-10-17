const moment = require('moment');

function createMashwaraCronService({
  queryDb,
  pushService,
  io = null,
  socketState = null,
  reminderMinutes = [10, 5, 1, 0],
  checkIntervalMs = 30 * 1000,
}) {
  if (!queryDb || !pushService) {
    console.warn('[MashwaraCron] queryDb or pushService missing. Mashwara reminder cron disabled.');
    return { stop: () => {}, checkAndSendReminders: async () => {} };
  }

  // Track sent notifications: key format `mashwara_{registrationId}_{role}_{userId}_{targetMin}`
  const sentNotifications = new Set();

  // Clear memory cache if too large every 2 hours
  setInterval(() => {
    if (sentNotifications.size > 5000) {
      sentNotifications.clear();
      console.log('[MashwaraCron] Cleared sent notifications cache.');
    }
  }, 2 * 60 * 60 * 1000);

  function getNotificationContent({ targetMin, sessionTitle, participantName, hostName, isHost }) {
    const formattedTitle = sessionTitle || 'Mashwara Session';
    const otherName = isHost ? participantName : hostName;

    if (targetMin === 10) {
      return {
        title: 'Mashwara Session in 10 Minutes',
        body: isHost
          ? `Your upcoming Mashwara session "${formattedTitle}" with ${otherName} will start in 10 minutes. Please get ready!`
          : `Your Mashwara session "${formattedTitle}" with ${otherName} will start in 10 minutes. Get ready to join!`,
      };
    }

    if (targetMin === 5) {
      return {
        title: 'Mashwara Session in 5 Minutes',
        body: isHost
          ? `Your upcoming Mashwara session "${formattedTitle}" with ${otherName} starts in 5 minutes. Please prepare to host.`
          : `Your Mashwara session "${formattedTitle}" with ${otherName} starts in 5 minutes. Please be ready!`,
      };
    }

    if (targetMin === 1) {
      return {
        title: 'Mashwara Session in 1 Minute',
        body: isHost
          ? `Your Mashwara session "${formattedTitle}" with ${otherName} starts in 1 minute. Please open the app!`
          : `Your Mashwara session "${formattedTitle}" with ${otherName} starts in 1 minute. Please prepare to join!`,
      };
    }

    // targetMin === 0 (starting now)
    return {
      title: 'Mashwara Session Starting Now!',
      body: isHost
        ? `Your Mashwara session "${formattedTitle}" with ${otherName} is starting now! Tap to begin.`
        : `Your Mashwara session "${formattedTitle}" with ${otherName} is starting now! Tap to join call.`,
    };
  }

  function matchesTargetInterval(diffSeconds, targetMin) {
    if (targetMin === 10) {
      // 9 to 11 minutes (540s to 660s)
      return diffSeconds >= 540 && diffSeconds <= 660;
    }
    if (targetMin === 5) {
      // 4 to 6 minutes (240s to 360s)
      return diffSeconds >= 240 && diffSeconds <= 360;
    }
    if (targetMin === 1) {
      // 45s to 105s (approx 1 min)
      return diffSeconds >= 45 && diffSeconds <= 105;
    }
    if (targetMin === 0) {
      // -45s to 45s (at start time)
      return diffSeconds >= -45 && diffSeconds <= 45;
    }
    return false;
  }

  async function checkAndSendReminders() {
    try {
      const now = moment();
      const dateStr = now.format('YYYY-MM-DD');
      const tomorrowStr = moment(now).add(1, 'day').format('YYYY-MM-DD');

      const sql = `
        SELECT 
          r.id as registration_id,
          r.live_chat_id,
          r.user_id as participant_id,
          r.slot_id,
          r.room_id,
          r.taken_time,
          COALESCE(s.slot_date, r.live_chat_date) as session_date,
          COALESCE(s.start_time, r.live_chat_start_time) as start_time,
          COALESCE(s.end_time, r.live_chat_end_time) as end_time,
          lc.title as session_title,
          COALESCE(lc.star_id, lc.created_by_id) as host_id,
          u.first_name as participant_first_name,
          u.last_name as participant_last_name,
          u.username as participant_username,
          u.device_id as participant_device_id,
          h.first_name as host_first_name,
          h.last_name as host_last_name,
          h.username as host_username,
          h.device_id as host_device_id
        FROM live_chat_registrations r
        LEFT JOIN live_chat_time_slots s ON r.slot_id = s.id
        JOIN live_chats lc ON r.live_chat_id = lc.id
        LEFT JOIN users u ON r.user_id = u.id
        LEFT JOIN users h ON COALESCE(lc.star_id, lc.created_by_id) = h.id
        WHERE (r.payment_status = 1 OR r.publish_status = 1)
          AND (
            (s.slot_date LIKE ? OR s.slot_date LIKE ?)
            OR (r.live_chat_date LIKE ? OR r.live_chat_date LIKE ?)
          )
      `;

      const rows = await queryDb(sql, [
        `${dateStr}%`,
        `${tomorrowStr}%`,
        `${dateStr}%`,
        `${tomorrowStr}%`,
      ]).catch(err => {
        console.error('[MashwaraCron] Error querying registrations:', err);
        return [];
      });

      if (!Array.isArray(rows) || rows.length === 0) {
        return;
      }

      for (const reg of rows) {
        const rawStart = String(reg.start_time || '').trim();
        if (!rawStart) continue;

        let sessionDateStr = dateStr;
        if (reg.session_date) {
          const match = String(reg.session_date).trim().match(/\d{4}-\d{2}-\d{2}/);
          if (match) {
            sessionDateStr = match[0];
          }
        }

        const startMoment = moment(`${sessionDateStr} ${rawStart}`, [
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

        const diffSeconds = startMoment.diff(now, 'seconds');

        // Only process sessions within -1 minute to +15 minutes
        if (diffSeconds < -60 || diffSeconds > 15 * 60) {
          continue;
        }

        const participantName = [reg.participant_first_name, reg.participant_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || reg.participant_username || 'Participant';

        const hostName = [reg.host_first_name, reg.host_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || reg.host_username || 'Consultant';

        for (const targetMin of reminderMinutes) {
          if (!matchesTargetInterval(diffSeconds, targetMin)) {
            continue;
          }

          // 1. Notify Participant
          if (reg.participant_id) {
            const pKey = `mashwara_${reg.registration_id}_participant_${reg.participant_id}_${targetMin}`;
            if (!sentNotifications.has(pKey)) {
              sentNotifications.add(pKey);

              const { title: pTitle, body: pBody } = getNotificationContent({
                targetMin,
                sessionTitle: reg.session_title,
                participantName,
                hostName,
                isHost: false,
              });

              const pData = {
                type: 'mashwara_reminder',
                registrationId: String(reg.registration_id),
                liveChatId: String(reg.live_chat_id),
                title: String(reg.session_title || 'Mashwara Session'),
                minutesBefore: String(targetMin),
                role: 'participant',
                remoteDisplayName: hostName,
                remoteUserId: String(reg.host_id || ''),
                sessionId: String(reg.room_id || `mashwara_${reg.registration_id}`),
                sessionDate: sessionDateStr,
                startTime: rawStart,
              };

              console.log(`[MashwaraCron 🚀] Sending ${targetMin}m reminder to Participant (User ${reg.participant_id}) for session ${reg.registration_id}`);

              // Push notification via FCM
              if (reg.participant_device_id) {
                pushService.sendPushToToken(reg.participant_device_id, pTitle, pBody, pData, {
                  channelId: 'default',
                }).catch(e => console.error('[MashwaraCron] Push error (participant):', e));
              }

              // Realtime Socket notification if connected
              if (io && socketState) {
                const pSocket = socketState.getConnectedUser(reg.participant_id) || socketState.getOnlineUser(reg.participant_id);
                if (pSocket?.socketId) {
                  io.to(pSocket.socketId).emit('mashwara_reminder', {
                    ...pData,
                    title: pTitle,
                    body: pBody,
                  });
                }
              }
            }
          }

          // 2. Notify Host
          if (reg.host_id) {
            const hKey = `mashwara_${reg.registration_id}_host_${reg.host_id}_${targetMin}`;
            if (!sentNotifications.has(hKey)) {
              sentNotifications.add(hKey);

              const { title: hTitle, body: hBody } = getNotificationContent({
                targetMin,
                sessionTitle: reg.session_title,
                participantName,
                hostName,
                isHost: true,
              });

              const hData = {
                type: 'mashwara_reminder',
                registrationId: String(reg.registration_id),
                liveChatId: String(reg.live_chat_id),
                title: String(reg.session_title || 'Mashwara Session'),
                minutesBefore: String(targetMin),
                role: 'host',
                remoteDisplayName: participantName,
                remoteUserId: String(reg.participant_id || ''),
                sessionId: String(reg.room_id || `mashwara_${reg.registration_id}`),
                sessionDate: sessionDateStr,
                startTime: rawStart,
              };

              console.log(`[MashwaraCron 🚀] Sending ${targetMin}m reminder to Host (User ${reg.host_id}) for session ${reg.registration_id}`);

              // Push notification via FCM
              if (reg.host_device_id) {
                pushService.sendPushToToken(reg.host_device_id, hTitle, hBody, hData, {
                  channelId: 'default',
                }).catch(e => console.error('[MashwaraCron] Push error (host):', e));
              }

              // Realtime Socket notification if connected
              if (io && socketState) {
                const hSocket = socketState.getConnectedUser(reg.host_id) || socketState.getOnlineUser(reg.host_id);
                if (hSocket?.socketId) {
                  io.to(hSocket.socketId).emit('mashwara_reminder', {
                    ...hData,
                    title: hTitle,
                    body: hBody,
                  });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[MashwaraCron] Error in checkAndSendReminders:', err);
    }
  }

  const intervalId = setInterval(checkAndSendReminders, checkIntervalMs);
  console.log(`[MashwaraCron] Initialized Mashwara reminder cron (checking every ${checkIntervalMs / 1000}s for [${reminderMinutes.join(', ')}] min reminders)`);

  // Run first check immediately on startup
  checkAndSendReminders();

  return {
    stop: () => clearInterval(intervalId),
    checkAndSendReminders,
  };
}

module.exports = {
  createMashwaraCronService,
};
