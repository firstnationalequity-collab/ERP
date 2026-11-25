// Attachments (docs/architecture.md §5, §7.1; decision Q17). Upload = raw file body + headers.
import { z } from 'zod';
import { WitnessSignRequest } from './esign';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Allowed file types, by content type and the extensions that may carry it. */
export const ATTACHMENT_TYPES: Record<string, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
};

/** Header carrying the URL-encoded original file name on upload. */
export const ATTACHMENT_FILE_NAME_HEADER = 'x-file-name';

export interface AttachmentDto {
  id: string;
  recordTable: string;
  recordId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  description: string | null;
  uploadedBy: string;
  uploadedAt: string;
  /** Void with reason (owner Q5, 2026-11-19; 0022): the file is kept and still downloadable, shown as void. */
  voided: { by: string; at: string; reason: string } | null;
}

/**
 * Void with a reason (owner Q5). A file on a GMP record also needs a QA Manager e-signature (owner 2026-11-25,
 * answer 1): `countersign` by a holder of qa.attachment.countersign, meaning APPROVED; the QA Manager may sign
 * their own void with their own username.
 */
export const VoidAttachmentRequest = z
  .object({
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500),
    countersign: WitnessSignRequest.optional(),
  })
  .strict();
export type VoidAttachmentRequest = z.infer<typeof VoidAttachmentRequest>;
