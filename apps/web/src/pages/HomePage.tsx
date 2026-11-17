import { Card, Col, Row, Statistic, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../layouts/AppLayout';
import { PageHeader } from '../components/PageHeader';

export function HomePage() {
  const { user, can } = useAuth();
  const inbox = useInboxCount(can('core.approval.inbox'));
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ status: string }>('/health') });

  return (
    <>
      <PageHeader title={`Welcome, ${user?.fullName ?? ''}`}>Signed in as {user?.username}.</PageHeader>
      <Row gutter={[16, 16]}>
        {can('core.approval.inbox') && (
          <Col xs={24} sm={12} lg={8}>
            <Card>
              <Statistic title="Approvals waiting for you" value={inbox.data?.count ?? 0} />
              <Link to="/approvals">Open my approvals</Link>
            </Card>
          </Col>
        )}
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic title="Permissions from your roles" value={user?.permissions.length ?? 0} />
            <Typography.Text type="secondary">The menu shows only what these allow.</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic title="Server" value={health.isLoading ? 'checking…' : (health.data?.status ?? 'unreachable')} />
          </Card>
        </Col>
      </Row>
    </>
  );
}
