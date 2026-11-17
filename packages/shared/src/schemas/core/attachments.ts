// Attachments (docs/architecture.md §5, §7.1; decision Q17). Upload = raw file body + headers.

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
}
