// /api/v1/core/attachments. Mounted behind authenticate + requireCurrentPassword.
// Upload: POST /attachments/:recordTable/:recordId with the raw file as body, its Content-Type, and the
// URL-encoded file name in X-File-Name. Permission per record type comes from the module's registration.
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ATTACHMENT_FILE_NAME_HEADER, ATTACHMENT_MAX_BYTES, VoidAttachmentRequest } from '@albert/shared';
import { AppError } from '../errors';
import { asyncHandler, authOf } from '../auth/middleware';
import { requirePermission } from '../rbac/require-permission';
import * as attachments from './attachments.service';

const RecordParams = z.object({
  recordTable: z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'Invalid record type'),
  recordId: z.string().regex(/^\d+$/, 'Invalid record id'),
});
const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const UploadQuery = z.object({ description: z.string().max(500).optional() });

// Raw body for uploads only; one byte over the limit is enough to refuse.
const rawBody = express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES + 1 });

/**
 * Route-level permission (CLAUDE.md: routes validate + check permission). The key comes from the module
 * that registered the record type; the service checks again and also checks that the record exists.
 */
function requireAttachmentAccess(mode: 'read' | 'write'): RequestHandler {
  return (req, res, next) => {
    const run = async () => {
      const recordTable =
        typeof req.params.id === 'string'
          ? await attachments.attachmentRecordTable(authOf(req), IdParam.parse(req.params).id)
          : RecordParams.parse(req.params).recordTable;
      requirePermission(attachments.attachmentPermission(recordTable, mode))(req, res, next);
    };
    run().catch(next);
  };
}

export const attachmentsRouter = Router();

attachmentsRouter.post(
  '/attachments/:recordTable/:recordId',
  requireAttachmentAccess('write'),
  (req, res, next) => {
    rawBody(req, res, (err?: unknown) => {
      if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
        next(new AppError('FILE_TOO_LARGE', `Files may be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`));
        return;
      }
      next(err);
    });
  },
  asyncHandler(async (req, res) => {
    const { recordTable, recordId } = RecordParams.parse(req.params);
    const { description } = UploadQuery.parse(req.query);
    const rawName = req.get(ATTACHMENT_FILE_NAME_HEADER) ?? '';
    let fileName: string;
    try {
      fileName = decodeURIComponent(rawName);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'X-File-Name must be URL-encoded');
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const dto = await attachments.upload(authOf(req), {
      recordTable,
      recordId,
      fileName,
      contentType: req.get('content-type') ?? '',
      bytes,
      description,
    });
    res.status(201).json(dto);
  }),
);

attachmentsRouter.get(
  '/attachments/:recordTable/:recordId',
  requireAttachmentAccess('read'),
  asyncHandler(async (req, res) => {
    const { recordTable, recordId } = RecordParams.parse(req.params);
    res.json(await attachments.list(authOf(req), recordTable, recordId));
  }),
);

attachmentsRouter.get(
  '/attachment-files/:id',
  requireAttachmentAccess('read'),
  asyncHandler(async (req, res) => {
    const { meta, bytes } = await attachments.download(authOf(req), IdParam.parse(req.params).id);
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`);
    res.setHeader('X-Content-SHA256', meta.sha256);
    res.end(bytes);
  }),
);

// Void with reason (owner Q5, 2026-11-19): the record type's write key; the file is kept and still served.
attachmentsRouter.post(
  '/attachment-files/:id/void',
  requireAttachmentAccess('write'),
  asyncHandler(async (req, res) => {
    res.json(await attachments.voidAttachment(authOf(req), IdParam.parse(req.params).id, VoidAttachmentRequest.parse(req.body)));
  }),
);
