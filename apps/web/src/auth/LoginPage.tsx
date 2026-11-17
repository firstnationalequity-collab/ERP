import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import type { LoginRequest } from '@albert/shared';
import { errorText } from '../api/client';
import { useAuth } from './AuthContext';

export function LoginPage() {
  const { login, signedOutReason } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (values: LoginRequest) => {
    setBusy(true);
    setError(null);
    try {
      await login(values);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f0f2f5', padding: 16 }}>
      <Card style={{ width: 380, maxWidth: '100%' }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Albert Pharma ERP
        </Typography.Title>
        {signedOutReason && !error && <Alert type="info" showIcon message={signedOutReason} style={{ marginBottom: 16 }} />}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form<LoginRequest> layout="vertical" onFinish={submit} requiredMark={false} autoComplete="off">
          <Form.Item name="username" label="Employee code" rules={[{ required: true, message: 'Enter your employee code' }]}>
            <Input prefix={<UserOutlined />} autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            Sign in
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          After 5 wrong passwords the account is locked until an administrator unlocks it.
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
