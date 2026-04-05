function createMessageService({queryDb}) {
  async function saveMessage(message) {
    const {
      uuid,
      conversation_id,
      user_id,
      encrypted_content,
      iv,
      message_type = 'text',
      metadata = null,
      reply_to = null,
    } = message;

    const result = await queryDb(
      `
        INSERT INTO messages (
          uuid,
          conversation_id,
          user_id,
          encrypted_content,
          iv,
          message_type,
          metadata,
          reply_to,
          is_edited,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
      `,
      [
        uuid,
        conversation_id,
        user_id,
        encrypted_content,
        iv,
        message_type,
        metadata,
        reply_to,
      ],
    );

    return {id: result.insertId, ...message};
  }

  async function saveMessageStatus(messageId, userId, status) {
    await queryDb(
      `
        INSERT INTO message_status (
          message_id,
          user_id,
          status,
          status_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, NOW(), NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          status_at = VALUES(status_at),
          updated_at = VALUES(updated_at)
      `,
      [messageId, userId, status],
    );
  }

  async function fetchMessageSender(messageId) {
    const rows = await queryDb(
      `
        SELECT user_id AS sender_id, conversation_id
        FROM messages
        WHERE id = ?
        LIMIT 1
      `,
      [messageId],
    );

    return rows[0] || null;
  }

  async function fetchConversationRecipients(conversationId, excludeUserId) {
    return queryDb(
      `
        SELECT
          u.id,
          u.device_id
        FROM conversation_participants cp
        INNER JOIN users u ON u.id = cp.user_id
        WHERE cp.conversation_id = ?
          AND cp.user_id <> ?
          AND u.device_id IS NOT NULL
          AND u.device_id <> ''
      `,
      [conversationId, excludeUserId],
    );
  }

  async function updateConversationTimestamp(conversationId) {
    if (!conversationId) return;

    try {
      await queryDb(
        `
          UPDATE conversations
          SET updated_at = NOW()
          WHERE id = ?
        `,
        [conversationId],
      );
    } catch (error) {
      console.error('Failed to update conversation timestamp:', error);
    }
  }

  async function fetchMessageHistory(conversationId, limit = 50, offset = 0) {
    const rows = await queryDb(
      `
        SELECT
          m.*,
          GROUP_CONCAT(CONCAT(ms.user_id, ':', ms.status) SEPARATOR ',') AS message_statuses
        FROM messages m
        LEFT JOIN message_status ms ON m.id = ms.message_id
        WHERE m.conversation_id = ?
        GROUP BY m.id
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
      `,
      [conversationId, limit, offset],
    );

    return rows
      .map(message => {
        const statuses = {};

        if (message.message_statuses) {
          message.message_statuses.split(',').forEach(statusPair => {
            const [userId, status] = statusPair.split(':');
            statuses[userId] = status;
          });
        }

        return {
          ...message,
          statuses,
          message_statuses: undefined,
        };
      })
      .reverse();
  }

  return {
    saveMessage,
    saveMessageStatus,
    fetchMessageSender,
    fetchConversationRecipients,
    updateConversationTimestamp,
    fetchMessageHistory,
  };
}

module.exports = {
  createMessageService,
};
