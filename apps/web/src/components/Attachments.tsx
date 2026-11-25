// Attachments of one record: list, download (the API re-checks the SHA-256 before serving) and, with the
// write key, upload and void. Files are never deleted: a wrong file is voided with a reason and kept, still
// downloadable and shown struck through (owner Q5, 2026-11-19).
import { useState } from 'react';
import { App, Button, List, Tag, Typography, Upload } from 'antd';
import { PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTACHMENT_FILE_NAME_HEADER, ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, type AttachmentDto } from '@albert/shared';
import { api, apiBlob, errorText } from '../api/client';
import { saveBlob } from '../lib/excel';
import { formatDateTime } from '../lib/format';
import { ReasonModal } from './ReasonModal';

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

/** A list of files (read-only inside an approval); with onVoid, each live file gets a Void action. */
export function AttachmentList({ items, onVoid }: { items: AttachmentDto[]; onVoid?(a: AttachmentDto): void }) {
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
            ...(onVoid && !a.voided
              ? [
                  <Button key="void" type="link" size="small" danger onClick={() => onVoid(a)}>
                    Void
                  </Button>,
                ]
              : []),
          ]}
        >
          <List.Item.Meta
            avatar={<PaperClipOutlined />}
            title={
              a.voided ? (
                <>
                  <Typography.Text delete>{a.fileName}</Typography.Text> <Tag color="red">VOID</Tag>
                </>
              ) : (
                a.fileName
              )
            }
            description={
              `${formatBytes(a.sizeBytes)} · ${a.uploadedBy}, ${formatDateTime(a.uploadedAt)}${a.description ? ` · ${a.description}` : ''}` +
              (a.voided ? ` · voided by ${a.voided.by}, ${formatDateTime(a.voided.at)}: ${a.voided.reason}` : '')
            }
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
  const [voiding, setVoiding] = useState<AttachmentDto | null>(null);

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
      <AttachmentList items={list.data ?? []} onVoid={canUpload ? setVoiding : undefined} />
      <ReasonModal
        open={voiding !== null}
        title={`Void ${voiding?.fileName ?? ''}`}
        text="The file is kept and stays downloadable, marked void with your name and reason. This cannot be undone."
        reasonRequired
        okText="Void"
        danger
        onCancel={() => setVoiding(null)}
        onSubmit={async (reason) => {
          if (!voiding) return;
          await api(`/core/attachment-files/${voiding.id}/void`, { method: 'POST', body: { reason } });
          void message.success(`${voiding.fileName} voided`);
          setVoiding(null);
          await qc.invalidateQueries({ queryKey: key });
        }}
      />
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
        Attachments are never deleted; a wrong file can be voided with a reason. PDF, images, Word, Excel, CSV or text; at most 20 MB.
      </Typography.Paragraph>
    </>
  );
}
