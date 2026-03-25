function createQnaService({queryDb, io}) {
  async function handleQnaSendMessage(data) {
    io.to(data.room_id).emit('qna_recive_message', data);

    try {
      const result = await queryDb(
        `
          INSERT INTO qna_messages (
            sender_id,
            qna_id,
            sender_name,
            room_id,
            msg_type,
            sender_image,
            media,
            text,
            time,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [
          data.sender_id,
          data.qna_id,
          data.sender_name,
          data.room_id,
          data.msg_type,
          data.sender_image,
          data.media,
          data.text,
          data.time,
          1,
        ],
      );

      if (!result.affectedRows || data?.is_star) {
        return;
      }

      await queryDb(
        `
          UPDATE qna_registrations
          SET remaining_seconds = remaining_seconds - ?
          WHERE qna_id = ? AND user_id = ?
        `,
        [data.duration, data.qna_id, data.sender_id],
      );
    } catch (error) {
      console.error('Failed to persist qna message:', error);
    }
  }

  return {
    handleQnaSendMessage,
  };
}

module.exports = {
  createQnaService,
};
