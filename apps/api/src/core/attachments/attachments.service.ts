// Attachments against any record (docs/architecture.md §5, §7.1; decision Q17).
// Each module declares which of its tables accept attachments and with which permission keys
// (registerAttachmentTarget). Files are insert-only; the SHA-256 is re-checked on every download.
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  type AttachmentDto,
  type PermissionKey,
} from '@albert/shared';
import { db, withTransaction, type Queryable } from '../../db/client';
import { attachments, users } from '../../db/schema/core';
import { AppError } from '../errors';
import { txContext, type AuthContext } from '../auth/auth.service';
import { storage } from '../storage/storage';

export interface AttachmentTarget {
  /** Key needed to list and download this record's files. */
  readPermission: PermissionKey;
  /** Key needed to upload. */
  writePermission: PermissionKey;
  /** Does the record exist in the acting company? */
  exists(q: Queryable, recordId: string): Promise<boolean>;
}

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

function toDto(row: typeof attachments.$inferSelect, uploader: string): AttachmentDto {
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
    .select({ a: attachments, uploader: users.fullName })
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
    .where(and(eq(attachments.companyId, auth.companyId), inArray(attachments.id, ids)));
  return rows.map((r) => toDto(r.a, r.uploader));
}

export async function list(auth: AuthContext, recordTable: string, recordId: string): Promise<AttachmentDto[]> {
  await checkAccess(auth, recordTable, recordId, 'read');
  const rows = await db
    .select({ a: attachments, uploader: users.fullName })
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
    .where(
      and(eq(attachments.companyId, auth.companyId), eq(attachments.recordTable, recordTable), eq(attachments.recordId, recordId)),
    )
    .orderBy(asc(attachments.id));
  return rows.map((r) => toDto(r.a, r.uploader));
}

/** Read a file, refusing it if it no longer matches the SHA-256 recorded at upload. */
export async function download(auth: AuthContext, id: string): Promise<{ meta: AttachmentDto; bytes: Buffer }> {
  const [row] = await db
    .select({ a: attachments, uploader: users.fullName })
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.createdBy))
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
  return { meta: toDto(row.a, row.uploader), bytes };
}
