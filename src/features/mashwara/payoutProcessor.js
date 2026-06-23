const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createDbConnection, connectDb, createQueryDb } = require('../../config/database');

const db = createDbConnection(process.env);
connectDb(db);
const queryDb = createQueryDb(db);

async function run() {
  console.log('[Payout Processor] Starting Mashwara delayed payout check...');
  try {
    // Fetch transactions of type 'livechat' with payout_status = 'held'
    // where the slot's scheduled end time is at least 1 hour in the past.
    const eligibleTxns = await queryDb(`
      SELECT t.id AS transaction_id, t.txn_amount, t.currency, t.user_id AS participant_user_id, t.event_id AS live_chat_id,
             r.slot_id, lc.star_id AS host_user_id,
             CONCAT(s.slot_date, ' ', s.end_time) AS slot_end
      FROM transactions t
      JOIN live_chat_registrations r ON r.live_chat_id = CAST(t.event_id AS UNSIGNED) AND r.user_id = t.user_id AND r.payment_status = 1
      JOIN live_chat_time_slots s ON s.id = r.slot_id
      JOIN live_chats lc ON lc.id = CAST(t.event_id AS UNSIGNED)
      WHERE t.event = 'livechat' AND t.status = '1' AND t.payout_status = 'held'
        AND CONCAT(s.slot_date, ' ', s.end_time) <= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);

    if (!eligibleTxns || eligibleTxns.length === 0) {
      console.log('[Payout Processor] No eligible held payouts found.');
      return;
    }

    console.log(`[Payout Processor] Found ${eligibleTxns.length} eligible payouts to release.`);

    for (const txn of eligibleTxns) {
      try {
        const hostUserId = Number(txn.host_user_id);
        if (!hostUserId || Number.isNaN(hostUserId)) {
          console.error(`[Payout Processor] Invalid host user ID: ${txn.host_user_id} for transaction ${txn.transaction_id}`);
          continue;
        }

        // 1. Atomic status update first to lock/claim the transaction.
        // This prevents race conditions and guarantees idempotency.
        const updateResult = await queryDb(
          `
            UPDATE transactions 
            SET payout_status = 'released', updated_at = NOW() 
            WHERE id = ? AND payout_status = 'held'
          `,
          [txn.transaction_id]
        );

        if (!updateResult || updateResult.affectedRows === 0) {
          console.log(`[Payout Processor] Transaction ${txn.transaction_id} already released by another instance. Skipping.`);
          continue;
        }

        console.log(`[Payout Processor] Locked transaction ${txn.transaction_id} for release.`);

        // 2. Fetch exchange rate for the transaction's currency
        const currencyCode = txn.currency || 'USD';
        const rates = await queryDb(
          'SELECT currency_value FROM currencies WHERE currency_code = ? LIMIT 1',
          [currencyCode]
        );

        let currencyValue = 1.00;
        if (rates && rates.length > 0) {
          const val = Number(rates[0].currency_value);
          if (Number.isFinite(val) && val > 0) {
            currencyValue = val;
          }
        }

        // Calculate amount in USD
        const rawAmount = Number(txn.txn_amount);
        const amount = Number((rawAmount / currencyValue).toFixed(2));

        console.log(`[Payout Processor] Processing txn ${txn.transaction_id}: converting ${rawAmount} ${currencyCode} to ${amount} USD (rate: ${currencyValue}) for host ${hostUserId}`);

        // 3. Update host's wallet (create if not exists)
        const wallets = await queryDb(
          'SELECT id FROM wallets WHERE user_id = ? LIMIT 1',
          [hostUserId]
        );

        if (!wallets || wallets.length === 0) {
          await queryDb(
            `
              INSERT INTO wallets (user_id, balance, held_balance, currency, created_at, updated_at)
              VALUES (?, ?, 0.00, 'USD', NOW(), NOW())
            `,
            [hostUserId, amount]
          );
          console.log(`[Payout Processor] Created new wallet for host ${hostUserId} with balance ${amount}`);
        } else {
          await queryDb(
            `
              UPDATE wallets 
              SET held_balance = GREATEST(0.00, held_balance - ?), 
                  balance = balance + ?,
                  updated_at = NOW()
              WHERE user_id = ?
            `,
            [amount, amount, hostUserId]
          );
          console.log(`[Payout Processor] Updated wallet for host ${hostUserId}: added ${amount} to balance`);
        }

        console.log(`[Payout Processor] Successfully completed release for transaction ${txn.transaction_id}`);
      } catch (txnError) {
        console.error(`[Payout Processor] Error processing transaction ${txn.transaction_id}:`, txnError);
      }
    }
  } catch (error) {
    console.error('[Payout Processor] Cron job failed:', error);
  } finally {
    db.end();
    console.log('[Payout Processor] Payout check finished. Database connection closed.');
  }
}

run();
