// E-signatures (rule 8; docs/architecture.md §7.1; decision Q3).
//
// Two steps, because a wrong password must be counted even though the action fails:
//   1. verifySignature / verifyWitness — own transaction; re-checks the password; a failure is committed
//      (failed_attempts + ESIGN_FAIL, lockout on the 5th) before ESIGN_FAILED is thrown.
//   2. recordSignature — inside the business transaction; stores the signature row.
// A SignatureProof can only be made here, is single-use and expires after 2 minutes.
import { and, eq, sql } from 'drizzle-orm';
import type { ESignRequest, SignatureMeaning, WitnessSignRequest } from '@albert/shared';
import { withTransaction, type Tx } from '../../db/client';
import { eSignatures, users } from '../../db/schema/core';
import { AppError } from '../errors';
import { registerFailedPassword, txContext, type AuthContext, type RequestMeta } from '../auth/auth.service';
import * as authRepo from '../auth/auth.repo';
import type { UserRow } from '../auth/auth.repo';
import { verifyPassword } from '../auth/password';

export const PROOF_TTL_MS = 2 * 60 * 1000;

const proofBrand: unique symbol = Symbol('SignatureProof');

export interface SignatureProof {
  readonly [proofBrand]: true;
  readonly userId: string;
  readonly companyId: string;
  readonly username: string;
  readonly fullName: string;
  readonly meaning: SignatureMeaning;
  readonly reason: string;
  readonly verifiedAt: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** A stored signature, as returned by recordSignature and checked by core/transition. */
export interface SignatureRecord {
  id: string;
  userId: string;
  meaning: SignatureMeaning;
  reason: string;
  recordTable: string;
  recordId: string;
}

/** Proofs issued and not yet used. Single use: recordSignature removes the proof. */
const unused = new WeakSet<SignatureProof>();

function makeProof(user: UserRow, input: ESignRequest, meta: RequestMeta): SignatureProof {
  const proof: SignatureProof = {
    [proofBrand]: true,
    userId: user.id,
    companyId: user.companyId,
    username: user.username,
    fullName: user.fullName,
    meaning: input.meaning,
    reason: input.reason.trim(),
    verifiedAt: Date.now(),
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
  unused.add(proof);
  return proof;
}

type Outcome = { ok: true; proof: SignatureProof } | { ok: false; error: AppError };

async function checkPassword(
  tx: Tx,
  user: UserRow,
  input: ESignRequest,
  meta: RequestMeta,
  role: 'signer' | 'witness',
): Promise<Outcome> {
  const failMessage = role === 'signer' ? 'E-signature failed: password is incorrect' : 'Witness signature failed';
  if (user.lockedAt) {
    return { ok: false, error: new AppError('ACCOUNT_LOCKED', role === 'signer' ? 'Your account is locked' : 'The witness account is locked') };
  }
  const hash = await authRepo.currentPasswordHash(tx, user.id);
  if (!hash || !(await verifyPassword(hash, input.password))) {
    const { locked } = await registerFailedPassword(tx, user, 'ESIGN_FAIL', meta, { meaning: input.meaning, role });
    if (locked) {
      return {
        ok: false,
        error: new AppError('ACCOUNT_LOCKED', role === 'signer' ? 'Your account is now locked after too many failed attempts' : 'The witness account is now locked'),
      };
    }
    return { ok: false, error: new AppError('ESIGN_FAILED', failMessage) };
  }
  if (user.failedAttempts > 0) await authRepo.updateUser(tx, user.id, { failedAttempts: 0 });
  return { ok: true, proof: makeProof(user, input, meta) };
}

/** Re-verify the signed-in user's password for an e-signature. */
export async function verifySignature(auth: AuthContext, input: ESignRequest, meta: RequestMeta): Promise<SignatureProof> {
  const outcome = await withTransaction(txContext(auth, 'e-signature check'), async (tx): Promise<Outcome> => {
    const user = await authRepo.findUserById(tx, auth.userId, true);
    if (!user || !user.isActive || user.isSystem) {
      return { ok: false, error: new AppError('ESIGN_FAILED', 'E-signature failed') };
    }
    return checkPassword(tx, user, input, meta, 'signer');
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.proof;
}

/**
 * A second person signs at the same terminal (QA witness, QA countersign).
 * The witness must be a different person; their wrong password counts against their own account.
 */
export async function verifyWitness(auth: AuthContext, input: WitnessSignRequest, meta: RequestMeta): Promise<SignatureProof> {
  const outcome = await withTransaction(txContext(auth, 'witness signature check'), async (tx): Promise<Outcome> => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.companyId, auth.companyId), sql`lower(${users.username}) = lower(${input.username})`))
      .for('update');
    if (!user || !user.isActive || user.isSystem) {
      return { ok: false, error: new AppError('ESIGN_FAILED', 'Witness signature failed') };
    }
    if (user.id === auth.userId) {
      return { ok: false, error: new AppError('SEGREGATION_OF_DUTIES', 'The witness must be a different person') };
    }
    return checkPassword(tx, user, input, meta, 'witness');
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.proof;
}

/**
 * Store a verified signature against a record, inside the business transaction.
 * Refuses a proof that was not issued here, was already used, has expired, or has a meaning not allowed here.
 */
export async function recordSignature(
  tx: Tx,
  proof: SignatureProof,
  record: { table: string; id: string },
  allowedMeanings?: readonly SignatureMeaning[],
): Promise<SignatureRecord> {
  if (!unused.has(proof)) throw new AppError('ESIGN_FAILED', 'This signature was already used or is not valid; sign again');
  unused.delete(proof);
  if (Date.now() - proof.verifiedAt > PROOF_TTL_MS) {
    throw new AppError('ESIGN_FAILED', 'The signature has expired; sign again');
  }
  if (allowedMeanings && !allowedMeanings.includes(proof.meaning)) {
    throw new AppError('ESIGN_FAILED', `Meaning ${proof.meaning} is not valid for this action`, { allowed: allowedMeanings });
  }
  const [row] = await tx
    .insert(eSignatures)
    .values({
      userId: proof.userId,
      signerUsername: proof.username,
      signerName: proof.fullName,
      meaning: proof.meaning,
      reason: proof.reason,
      recordTable: record.table,
      recordId: record.id,
      ip: proof.ip,
      userAgent: proof.userAgent,
    })
    .returning();
  if (!row) throw new Error('e-signature insert returned no row');
  return {
    id: row.id,
    userId: row.userId,
    meaning: row.meaning,
    reason: row.reason,
    recordTable: row.recordTable,
    recordId: row.recordId,
  };
}
