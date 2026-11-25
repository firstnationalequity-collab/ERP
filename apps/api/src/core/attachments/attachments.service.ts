// Attachments against any record (docs/architecture.md §5, §7.1; decision Q17).
// Each module declares which of its tables accept attachments and with which permission keys
// (registerAttachmentTarget). Files are never deleted; a file can be voided once, with a reason (owner Q5,
// 2026-11-19; 0022), and stays downloadable. The SHA-256 is re-checked on every download.
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  type AttachmentDto,
  type PermissionKey,
  type VoidAttachmentRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable } from '../../db/client';
import { attachments, users } from '../../db/schema/core';
import { AppError } from '../errors';
import { txContext, type AuthContext, type RequestMeta } from '../auth/auth.service';
import { permissionKeysForUser } from '../auth/auth.repo';
import { recordSignature, verifySignature, verifyWitness, type SignatureProof } from '../esign/esign.service';
import { storage } from '../storage/storage';

export interface AttachmentTarget {
  /** Key needed to list and download this record's files. */
  readPermission: PermissionKey;
  /** Key needed to upload. */
  writePermission: PermissionKey;
  /** Does the record exist in the acting company? */
  exists(q: Queryable, recordId: string): Promise<boolean>;
  /**
   * A GMP record (AVL evidence, QC records, batch documents): voiding one of its files also needs a QA Manager
   * e-signature (owner 2026-11-25, answer 1). Mirrored by core.gmp_attachment_tables() (0025, tested equal).
   */
  gmp: boolean;
}

/** Key of the QA Manager e-signature that voids a file on a GMP record. */
export const GMP_VOID_KEY: PermissionKey = 'qa.attachment.countersign';

const targets = new Map<string, AttachmentTarget>();

export function registerAttachmentTarget(recordTable: string, target: AttachmentTarget): void {
  if (!/^[a-z_]+\.[a-z_]+$/.test(recordTable)) throw new Error(`Bad record table ${recordTable}`);
  if (targets.has(recordTable)) throw new Error(`Attachment target ${recordTable} is already registered`);
  targets.set(recordTable, target);
}

/** The permission key a record type needs for reading or writing attachments (for the route check). */
export function attachmentPermission(recordTable: string, mode: 'read' | 'write'): PermissionKey {
  const target = targets.get(recordTable);
  if (!target) throw new AppError('NOT_FOUND', `Records of ${recordTable} do not take attachments`);
  return mode === 'read' ? target.readPermission : target.writePermission;
}

/** Record tables whose files need a QA Manager e-signature to void (for the DB mirror test). */
export function gmpAttachmentTables(): string[] {
  return [...targets].filter(([, t]) => t.gmp).map(([table]) => table).sort();
}

/** Record type of a stored attachment (for the route check on downloads). */
export async function attachmentRecordTable(auth: AuthContext, id: string): Promise<string> {
  const [row] = await db
    .select({ recordTable: attachments.recordTable })
    .from(attachments)
    .where(and(eq(attachments.companyId, auth.companyId), eq(attachments.id, id)));
  if (!row) throw new AppError('NOT_FOUND', 'Attachment not found');
  return row.recordTable;
}

async function checkAccess(auth: AuthContext, recordTable: string, recordId: string, mode: 'read' | 'write'): Promise<void> {
  const target = targets.get(recordTable);
  if (!target) throw new AppError('NOT_FOUND', `Records of ${recordTable} do not take attachments`);
  const key = mode === 'read' ? target.readPermission : target.writePermission;
  if (!auth.permissions.has(key)) {
    throw new AppError('FORBIDDEN', 'You do not have permission for these attachments', { permission: key });
  }
  if (!(await target.exists(db, recordId))) throw new AppError('NOT_FOUND', 'Record not found');
}

/** Keep a readable name but drop anything that could break headers or paths. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // Keep printable characters only (no control characters in headers or logs).
  const printable = [...base].filter((c) => c >= ' ' && c !== '\u007f').join('');
  return printable.replace(/["<>|:*?]/g, '_').trim().slice(0, 200);
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const voider = alias(users, 'voider');
const rowColumns = { a: attachments, uploader: users.fullName, voidedByName: voider.fullName };

function toDto(row: typeof attachments.$inferSelect, uploader: string, voidedByName: string | null): AttachmentDto {
  return {
    id: row.id,
    recordTable: row.recordTable,
    recordId: row.recordId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    description: row.description,
    uploadedBy: uploader,
    uploadedAt: row.createdAt.toISOString(),
    voided:
      row.voidedAt && row.voidReason
        ? { by: voidedByName ?? '', at: row.voidedAt.toISOString(), reason: row.voidReason }
        : null,
  };
}

export interface UploadInput {
  recordTable: string;
  recordId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  description?: string;
}

export async function upload(auth: AuthContext, input: UploadInput): Promise<AttachmentDto> {
  await checkAccess(auth, input.recordTable, input.recordId, 'write');
  const fileName = cleanFileName(input.fileName);
  if (!fileName) throw new AppError('VALIDATION_FAILED', 'A file name is required');
  const contentType = input.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const allowedExt = ATTACHMENT_TYPES[contentType];
  if (!allowedExt || !allowedExt.includes(extensionOf(fileName))) {
    throw new AppError('FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed', { allowed: Object.keys(ATTACHMENT_TYPES) });
  }
  if (input.bytes.length === 0) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (input.bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError('FILE_TOO_LARGE', `Files may be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const store = storage();
  // Write the file first; if the database insert fails, an orphan file remains but no record points to it.
  const storageKey = await store.put(input.bytes);
  const id = await withTransaction(txContext(auth, `attach ${fileName}`), async (tx) => {
    const [row] = await tx
      .insert(attachments)
      .values({
        recordTable: input.recordTable,
        recordId: input.recordId,
        fileName,
        contentType,
        sizeBytes: String(input.bytes.length),
        sha256,
        storageDriver: store.driver,
        storageKey,
        description: input.description?.trim() || null,
      })
      .returning({ id: attachments.id });
    if (!row) throw new Error('attachment insert returned no row');
    return row.id;
  });
  const [dto] = await listByIds(auth, [id]);
  if (!dto) throw new AppError('NOT_FOUND', 'Attachment not found');
  return dto;
}

async function listByIds(auth: AuthContext, ids: string[]): Promise<AttachmentDto[]> {
  const rows = await db
    .select(rowColumns)
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
    .leftJoin(voider, eq(voider.id, attachments.voidedBy))
    .where(and(eq(attachments.companyId, auth.companyId), inArray(attachments.id, ids)));
  return rows.map((r) => toDto(r.a, r.uploader, r.voidedByName));
}

export async function list(auth: AuthContext, recordTable: string, recordId: string): Promise<AttachmentDto[]> {
  await checkAccess(auth, recordTable, recordId, 'read');
  const rows = await db
    .select(rowColumns)
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
    .leftJoin(voider, eq(voider.id, attachments.voidedBy))
    .where(
      and(eq(attachments.companyId, auth.companyId), eq(attachments.recordTable, recordTable), eq(attachments.recordId, recordId)),
    )
    .orderBy(asc(attachments.id));
  return rows.map((r) => toDto(r.a, r.uploader, r.voidedByName));
}

/**
 * Files of a document for display beside it (e.g. on the approval e-signature screen). Never throws for
 * access: returns [] when the record type takes no attachments or the viewer lacks its read key.
 */
export async function listForDocument(auth: AuthContext, recordTable: string, recordId: string): Promise<AttachmentDto[]> {
  const target = targets.get(recordTable);
  if (!target || !auth.permissions.has(target.readPermission)) return [];
  return list(auth, recordTable, recordId);
}

/** How many files a record has, voided files not counted (for module rules such as "AVL approval needs evidence"). */
export async function countForDocument(q: Queryable, companyId: string, recordTable: string, recordId: string): Promise<number> {
  const rows = await q
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.companyId, companyId),
        eq(attachments.recordTable, recordTable),
        eq(attachments.recordId, recordId),
        isNull(attachments.voidedAt),
      ),
    );
  return rows.length;
}

/** Read a file, refusing it if it no longer matches the SHA-256 recorded at upload. */
export async function download(auth: AuthContext, id: string): Promise<{ meta: AttachmentDto; bytes: Buffer }> {
  const [row] = await db
    .select(rowColumns)
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
    .leftJoin(voider, eq(voider.id, attachments.voidedBy))
    .where(and(eq(attachments.companyId, auth.companyId), eq(attachments.id, id)));
  if (!row) throw new AppError('NOT_FOUND', 'Attachment not found');
  await checkAccess(auth, row.a.recordTable, row.a.recordId, 'read');
  let bytes: Buffer;
  try {
    bytes = await storage().get(row.a.storageKey);
  } catch {
    throw new AppError('FILE_INTEGRITY_FAILED', 'The stored file is missing');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.a.sha256) {
    throw new AppError('FILE_INTEGRITY_FAILED', 'The stored file does not match its recorded checksum');
  }
  return { meta: toDto(row.a, row.uploader, row.voidedByName), bytes };
}

/**
 * Void a file with a reason (owner Q5): needs the record type's write key; the file is kept and never deleted.
 * A file on a GMP record also needs a QA Manager e-signature (owner 2026-11-25, answer 1): a holder of
 * qa.attachment.countersign signs with meaning APPROVED (the QA Manager may sign their own void); the signature
 * is stored on the attachment in the same transaction and the DB checks it at commit (0025).
 */
export async function voidAttachment(auth: AuthContext, id: string, input: VoidAttachmentRequest, meta: RequestMeta): Promise<AttachmentDto> {
  const reason = input.reason.trim();
  const target = targets.get(await attachmentRecordTable(auth, id));
  if (!target) throw new AppError('NOT_FOUND', 'Records of this type do not take attachments');
  let proof: SignatureProof | undefined;
  if (target.gmp) {
    const cs = input.countersign;
    if (!cs) {
      throw new AppError('COUNTERSIGN_REQUIRED', 'This file is GMP evidence: voiding it needs a QA Manager e-signature', { permission: GMP_VOID_KEY });
    }
    if (cs.meaning !== 'APPROVED') throw new AppError('ESIGN_FAILED', 'The QA Manager signs with the meaning APPROVED');
    proof =
      cs.username.trim().toLowerCase() === auth.username.toLowerCase()
        ? await verifySignature(auth, cs, meta)
        : await verifyWitness(auth, cs, meta);
  } else if (input.countersign) {
    throw new AppError('VALIDATION_FAILED', 'This file is not GMP evidence; it is voided without a QA e-signature', { field: 'countersign' });
  }
  await withTransaction(txContext(auth, `void attachment: ${reason}`), async (tx) => {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.companyId, auth.companyId), eq(attachments.id, id)))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', 'Attachment not found');
    await checkAccess(auth, row.recordTable, row.recordId, 'write');
    if (row.voidedAt) throw new AppError('INVALID_TRANSITION', 'This attachment is already void');
    if (proof) {
      if (!(await permissionKeysForUser(tx, proof.userId)).includes(GMP_VOID_KEY)) {
        throw new AppError('FORBIDDEN', `The signer does not hold ${GMP_VOID_KEY} (QA Manager)`, { permission: GMP_VOID_KEY });
      }
      await recordSignature(tx, proof, { table: 'core.attachments', id }, ['APPROVED']);
    }
    await tx
      .update(attachments)
      .set({ voidedAt: new Date(), voidedBy: auth.userId, voidReason: reason })
      .where(eq(attachments.id, id));
  });
  const [dto] = await listByIds(auth, [id]);
  if (!dto) throw new AppError('NOT_FOUND', 'Attachment not found');
  return dto;
}
