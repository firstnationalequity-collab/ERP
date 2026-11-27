// Test-only lot fixtures that use the moves the system allows (rule 1; 0037). A material lot is never walked
// UNDER_TEST → APPROVED / REJECTED by raw SQL: that needs a QC disposition, which needs a real sample (and the sample
// takes stock). So a fixture that needs:
//  - an APPROVED material lot creates it for an item with qc_required = false (created APPROVED at GRN, answer 4);
//  - a REJECTED material lot takes such a lot APPROVED → HOLD (QA, qa.lot.hold) → REJECTED by a QC Manager's
//    disposition with their own e-signature on the lot (rejectLotForTest), exactly the rows the service writes.
import { sql } from 'drizzle-orm';
import { withTransaction } from '../db/client';

const history = (lotId: string, from: string, to: string, actor: string, esignId: string | null = null, reason = 'Test fixture') =>
  sql`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id, esign_id, reason)
      VALUES ('inv.lots', ${lotId}, ${from}, ${to}, ${actor}, ${esignId}, ${reason})`;

/** APPROVED (or HOLD) material lot → REJECTED: QA holds it, then the QC Manager rejects it with an e-signature. */
export async function rejectLotForTest(lotId: string, people: { qaUserId: string; qcManagerUserId: string }): Promise<void> {
  const reason = 'Rejected in a test fixture';
  await withTransaction({ userId: people.qaUserId, companyId: '1' }, async (tx) => {
    const { rows } = await tx.execute<{ status: string }>(sql`SELECT status FROM inv.lots WHERE id = ${lotId} FOR UPDATE`);
    const status = rows[0]?.status;
    if (status === 'HOLD') return;
    if (status !== 'APPROVED') throw new Error(`rejectLotForTest: lot ${lotId} is ${status}; start from an APPROVED lot`);
    await tx.execute(history(lotId, 'APPROVED', 'HOLD', people.qaUserId, null, 'Held in a test fixture'));
    await tx.execute(sql`UPDATE inv.lots SET status = 'HOLD' WHERE id = ${lotId}`);
  });
  await withTransaction({ userId: people.qcManagerUserId, companyId: '1' }, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
      SELECT u.id, u.username, u.full_name, 'REJECTED', ${reason}, 'inv.lots', ${lotId} FROM core.users u WHERE u.id = ${people.qcManagerUserId}
      RETURNING id`);
    const esignId = rows[0]!.id;
    // 0038: a HOLD rejection names its reason category and describes what was found.
    await tx.execute(sql`INSERT INTO qc.dispositions (lot_id, from_status, decision, reason, reject_category, reject_description, esign_id)
      VALUES (${lotId}, 'HOLD', 'REJECTED', ${reason}, 'OTHER', 'Test fixture: rejected after a QA hold', ${esignId})`);
    await tx.execute(history(lotId, 'HOLD', 'REJECTED', people.qcManagerUserId, esignId, reason));
    await tx.execute(sql`UPDATE inv.lots SET status = 'REJECTED' WHERE id = ${lotId}`);
  });
}
