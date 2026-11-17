// E-signature dialog (rule 8): password re-entry, a fixed meaning, and a reason.
// With `countersign`, a second person (QA Manager) signs at the same terminal with their own credentials.
import { useEffect, useState } from 'react';
import { Alert, Divider, Form, Input, Modal, Tag, Typography } from 'antd';
import type { ESignRequest, SignatureMeaning, WitnessSignRequest } from '@albert/shared';
import { errorText } from '../api/client';

export interface ESignResult {
  signature: ESignRequest;
  countersign?: WitnessSignRequest;
  /** Reason for the change itself (role/assignment changes). */
  reason: string;
}

interface Props {
  open: boolean;
  title: string;
  /** The meaning the signer confirms (shown, not editable). */
  meaning: SignatureMeaning;
  /** What the user is about to do, in one sentence. */
  summary?: string;
  /** Collect the signer's own password (default true). Role admin changes only need a reason + countersign. */
  ownSignature?: boolean;
  /** 'required' shows the QA countersign block; 'none' hides it. */
  countersign?: 'required' | 'none';
  countersignNote?: string;
  /** Who countersigns, e.g. "QA Manager" (default) or "Finance Manager". */
  countersignBy?: string;
  okText?: string;
  onCancel(): void;
  /** Throw to keep the dialog open and show the error. */
  onSubmit(result: ESignResult): Promise<void>;
}

interface Values {
  password?: string;
  reason: string;
  csUsername?: string;
  csPassword?: string;
  csReason?: string;
}

export function ESignModal(props: Props) {
  const { open, title, meaning, summary, ownSignature = true, countersign = 'none', countersignNote, countersignBy = 'QA Manager', okText, onCancel, onSubmit } = props;
  const [form] = Form.useForm<Values>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setError(null);
    }
  }, [open, form]);

  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        reason: v.reason,
        signature: { password: v.password ?? '', meaning, reason: v.reason },
        countersign:
          countersign === 'required'
            ? { username: v.csUsername ?? '', password: v.csPassword ?? '', meaning: 'APPROVED', reason: v.csReason ?? '' }
            : undefined,
      });
    } catch (err) {
      setError(errorText(err));
      form.setFieldsValue({ password: undefined, csPassword: undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={title} okText={okText ?? 'Sign'} onOk={() => void submit()} onCancel={onCancel} confirmLoading={busy} destroyOnClose maskClosable={false}>
      {summary && <Typography.Paragraph>{summary}</Typography.Paragraph>}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" requiredMark={false} autoComplete="off">
        {ownSignature && (
          <>
            <Typography.Paragraph>
              Meaning of your signature: <Tag color="blue">{meaning}</Tag>
            </Typography.Paragraph>
            <Form.Item name="password" label="Your password" rules={[{ required: true, message: 'Re-enter your password to sign' }]}>
              <Input.Password autoComplete="off" />
            </Form.Item>
          </>
        )}
        <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3, message: 'Give a reason (at least 3 characters)' }]}>
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        {countersign === 'required' && (
          <>
            <Divider orientation="left" plain>
              {countersignBy} countersign
            </Divider>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {countersignNote ?? 'This change touches QC/QA action keys. A QA Manager must countersign here with their own password.'}
            </Typography.Paragraph>
            <Form.Item name="csUsername" label={`${countersignBy} employee code`} rules={[{ required: true }]}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="csPassword" label={`${countersignBy} password`} rules={[{ required: true }]}>
              <Input.Password autoComplete="off" />
            </Form.Item>
            <Form.Item name="csReason" label="Countersign reason" rules={[{ required: true, min: 3 }]}>
              <Input />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
