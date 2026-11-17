import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { databaseUrl } from '../config/env';

// Return NUMERIC (oid 1700) as string, never as JS number — convert with decimal.js.
pg.types.setTypeParser(1700, (v) => v);
// Return BIGINT (oid 20) as string to avoid precision loss on ids.
pg.types.setTypeParser(20, (v) => v);

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
export const db = drizzle(pool);
export type Db = NodePgDatabase;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TxContext {
  userId: string;
  /** Reason recorded in the audit log for every change in this transaction (optional). */
  reason?: string;
}

/**
 * Run work in one DB transaction with the acting user set for the audit trigger.
 * Every business write MUST go through this so core.audit_log knows who did it.
 */
export async function withTransaction<T>(ctx: TxContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) = local to this transaction only
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.reason', ${ctx.reason ?? ''}, true)`,
    );
    return work(tx);
  });
}
