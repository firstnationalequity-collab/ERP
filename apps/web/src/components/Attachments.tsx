// Attachments of one record: list, download (the API re-checks the SHA-256 before serving) and, with the
// write key, upload. Files are insert-only (decision Q17): there is no delete.
import { App, Button, List, Typography, Upload } from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_FILE_NAME_HEADER, ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, type AttachmentDto } from '@albert/shared';
import { api, apiBlob, errorText } from '../api/client';
import { saveBlob } from '../lib/excel';
import { formatDateTime } from '../lib/format';

const ACCEPT = Object.values(ATTACHMENT_TYPES)
  .flat()
  .map((e) => `.${e}`)
  .join(',');

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function downloadAttachment(a: AttachmentDto): Promise<void> {
  saveBlob(await apiBlob(`/core/attachment-files/${a.id}`), a.fileName);
}

/** A read-only list (e.g. inside an approval). */
export function AttachmentList({ items }: { items: AttachmentDto[] }) {
  const { message } = App.useApp();
  return (
    <List
      size="small"
      bordered
      dataSource={items}
      locale={{ emptyText: 'No attachments' }}
      renderItem={(a) => (
        <List.Item
          actions={[
            <Button key="dl" type="link" size="small" onClick={() => downloadAttachment(a).catch((err: unknown) => void message.error(errorText(err)))}>
              Download
            </Button>,
          ]}
        >
          <List.Item.Meta
            avatar={<PaperClipOutlined />}
            title={a.fileName}
            description={`${formatBytes(a.sizeBytes)} · ${a.uploadedBy}, ${formatDateTime(a.uploadedAt)}${a.description ? ` · ${a.description}` : ''}`}
          />
        </List.Item>
      )}
    />
  );
}

/** List + upload for one record. */
export function AttachmentsPanel({ recordTable, recordId, canUpload }: { recordTable: string; recordId: string; canUpload: boolean }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const key = ['attachments', recordTable, recordId];
  const list = useQuery({ queryKey: key, queryFn: () => api<AttachmentDto[]>(`/core/attachments/${recordTable}/${recordId}`) });

  const upload = async (file: File) => {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      void message.error(`Files may be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`);
      return;
    }
    try {
      await api(`/core/attachments/${recordTable}/${recordId}`, {
        method: 'POST',
        rawBody: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', [ATTACHMENT_FILE_NAME_HEADER]: encodeURIComponent(file.name) },
      });
      void message.success(`${file.name} attached`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      void message.error(errorText(err));
    }
  };

  return (
    <>
      <AttachmentList items={list.data ?? []} />
      {canUpload && (
        <Upload
          accept={ACCEPT}
          showUploadList={false}
          beforeUpload={(file) => {
            void upload(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} style={{ marginTop: 8 }}>
            Attach a file
          </Button>
        </Upload>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        Attachments cannot be removed once uploaded. PDF, images, Word, Excel, CSV or text; at most 20 MB.
      </Typography.Paragraph>
    </>
  );
}
