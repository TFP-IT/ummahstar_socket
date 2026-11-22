/**
 * Applies the user's Notification Settings (Laravel `user_settings` table,
 * notify_* columns) to pushes sent from the socket server.
 *
 * Same rules as backend.ummahstar/app/Support/NotificationPreferences.php:
 *  - a muted category stops the push for that user
 *  - notify_do_not_disturb stops every push
 *  - no settings row yet = defaults = allowed
 *  - if the lookup fails, the push is sent (never lose a notification)
 *
 * Calls (audio/video, Mashwara call, live-stream invites) are not filtered.
 */

// Category => column. Only these names ever reach the SQL.
const CATEGORY_COLUMNS = {
  salaambox: 'notify_salaambox',
  noor_access: 'notify_noor_access',
  spark: 'notify_spark',
  starmates: 'notify_starmates',
  general: 'notify_general_activity',
};

function createNotificationPrefsService({queryDb}) {
  /**
   * Returns the subset of userIds that may receive a push of this category.
   */
  async function filterAllowed(userIds, category) {
    const column = CATEGORY_COLUMNS[category];
    const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    if (!column || ids.length === 0) {
      return new Set(ids);
    }

    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = await queryDb(
        `SELECT user_id, notify_do_not_disturb, ${column} AS enabled
           FROM user_settings
          WHERE user_id IN (${placeholders})`,
        ids,
      );

      const muted = new Set(
        (rows || [])
          .filter(row => Number(row.notify_do_not_disturb) === 1 || Number(row.enabled) === 0)
          .map(row => Number(row.user_id)),
      );

      return new Set(ids.filter(id => !muted.has(id)));
    } catch (error) {
      console.error('[notificationPrefs] lookup failed, sending anyway:', error.message);
      return new Set(ids);
    }
  }

  async function isAllowed(userId, category) {
    const allowed = await filterAllowed([userId], category);
    return allowed.has(Number(userId));
  }

  return {filterAllowed, isAllowed};
}

module.exports = {
  createNotificationPrefsService,
  CATEGORY_COLUMNS,
};
