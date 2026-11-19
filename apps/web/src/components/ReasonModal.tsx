// A confirm dialog that collects the reason for an action (activate, deactivate). Deactivation always needs a
// reason (API: DeactivateRequest); activation takes an optional one. Not an e-signature: no password.
import { useEffect, useState } from 'react';
import { Alert, Input, Modal, Typography } from 'antd';
import { errorText } from '../api/client';

interface Props {
  open: boolean;
  title: string;
  text?: string;
  reasonRequired: boolean;
  okText?: string;
  danger?: boolean;
  onCancel(): void;
  /** Throw to keep the dialog open and show the error. */
  onSubmit(reason: string | undefined): Promise<unknown>;
}

export function ReasonModal({ open, title, text, reasonRequired, okText, danger, onCancel, onSubmit }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const ok = async () => {
    const r = reason.trim();
    if (reasonRequired && r.length < 3) {
      setError('Give a reason (at least 3 characters)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(r || undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={title} okText={okText ?? 'Confirm'} okButtonProps={{ danger }} onOk={() => void ok()} onCancel={onCancel} confirmLoading={busy} destroyOnClose>
      {text && <Typography.Paragraph>{text}</Typography.Paragraph>}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Input.TextArea
        rows={2}
        maxLength={500}
        aria-label="Reason"
        placeholder={reasonRequired ? 'Reason (required)' : 'Reason (optional)'}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}
