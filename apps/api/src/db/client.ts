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
/** Repos accept either: a transaction for writes, or the pool for plain reads. */
export type Queryable = Db | Tx;

/** Created by migration 0001: the only company, and the SYSTEM user (actor for seeds and jobs). */
export const COMPANY_ID = '1';
export const SYSTEM_USER_ID = '1';

export interface TxContext {
  userId: string;
  /** Company of the acting user; every row's company_id defaults to it. */
  companyId: string;
  /** Reason recorded in the audit log for every change in this transaction (optional). */
  reason?: string;
}

/** Context for seeds and background jobs: acts as the SYSTEM user. */
export function systemContext(reason?: string): TxContext {
  return { userId: SYSTEM_USER_ID, companyId: COMPANY_ID, reason };
}

/**
 * Run work in one DB transaction with the acting user and company set for the audit trigger
 * and the created_by/updated_by/company_id column defaults.
 * Every business write MUST go through this so core.audit_log knows who did it.
 */
export async function withTransaction<T>(ctx: TxContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) = local to this transaction only
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true),
                 set_config('app.company_id', ${ctx.companyId}, true),
                 set_config('app.reason', ${ctx.reason ?? ''}, true)`,
    );
    return work(tx);
  });
}

/**
 * Change the acting user inside a running transaction. Used by login: the transaction starts as SYSTEM
 * (the caller is not yet known) and switches to the user once the password has been verified.
 */
export async function setActor(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}
