// Change password: forced at first login / after an admin reset / after 90 days, or by choice.
// The policy is checked live with the same rules the API uses (packages/shared/password.ts).
import { useState } from 'react';
import { Alert, Button, Card, Form, Input, List, Typography } from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone } from '@ant-design/icons';
import { PASSWORD_HISTORY_DEPTH, PASSWORD_MIN_LENGTH, passwordPolicyErrors } from '@albert/shared';
import { api, errorText } from '../api/client';
import { useAuth } from './AuthContext';

const RULES = [
  `At least ${PASSWORD_MIN_LENGTH} characters`,
  'At least one upper-case letter',
  'At least one lower-case letter',
  'At least one digit',
  'Must not contain the username',
];

interface Values {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

export function ChangePasswordPage({ forced, onDone }: { forced: boolean; onDone?: () => void }) {
  const { user, reload, logout } = useAuth();
  const [form] = Form.useForm<Values>();
  const newPassword = Form.useWatch('newPassword', form) ?? '';
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const broken = new Set(passwordPolicyErrors(newPassword, user?.username ?? ''));

  const submit = async (values: Values) => {
    setBusy(true);
    setError(null);
    try {
      await api('/core/auth/change-password', {
        method: 'POST',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      form.resetFields();
      setDone(true);
      await reload();
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reason = user?.mustChangePassword
    ? 'You must set your own password before you continue.'
    : 'Your password is older than 90 days. Set a new one to continue.';

  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card style={{ width: 460, maxWidth: '100%' }} title="Change password">
        {forced && <Alert type="warning" showIcon message={reason} style={{ marginBottom: 16 }} />}
        {done && !forced && <Alert type="success" showIcon message="Password changed. Other sessions were signed out." style={{ marginBottom: 16 }} />}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} autoComplete="off">
          <Form.Item name="currentPassword" label="Current password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="New password"
            rules={[
              { required: true },
              {
                validator: (_r, v: string | undefined) =>
                  !v || passwordPolicyErrors(v, user?.username ?? '').length === 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('The password does not meet the rules below')),
              },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <List
            size="small"
            dataSource={RULES}
            style={{ marginTop: -8, marginBottom: 16 }}
            renderItem={(rule) => (
              <List.Item style={{ padding: '2px 0', border: 0 }}>
                {newPassword && !broken.has(rule) ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : <CloseCircleTwoTone twoToneColor="#bfbfbf" />}{' '}
                <Typography.Text type={newPassword && !broken.has(rule) ? undefined : 'secondary'}>{rule}</Typography.Text>
              </List.Item>
            )}
          />
          <Form.Item
            name="confirm"
            label="Repeat new password"
            dependencies={['newPassword']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_r, v: string | undefined) =>
                  !v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('The passwords do not match')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            You cannot reuse any of your last {PASSWORD_HISTORY_DEPTH} passwords.
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" loading={busy} block>
            Change password
          </Button>
          {forced && (
            <Button type="link" block onClick={() => void logout()} style={{ marginTop: 8 }}>
              Sign out
            </Button>
          )}
        </Form>
      </Card>
    </div>
  );
}
