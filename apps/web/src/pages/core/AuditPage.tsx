// Audit trail viewer (core.audit.view; architecture §7.1): filter by table, record, user, date.
// Read-only: the trail is written by database triggers and cannot be changed.
import { useState } from 'react';
import { Button, DatePicker, Drawer, Form, Input, Select, Space, Table, Tabs, Tag, Timeline, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import type { AuditEntryDto, AuthEventDto, ESignatureDto, Page, StatusHistoryDto, UserDto } from '@albert/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, toBusinessDate } from '../../lib/format';

interface Filters {
  table?: string;
  recordId?: string;
  userId?: string;
  action?: 'INSERT' | 'UPDATE' | 'DELETE';
  range?: [Dayjs, Dayjs];
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function AuditPage() {
  return (
    <>
      <PageHeader title="Audit trail">Every change to business data, written by the database. Times are Pakistan time.</PageHeader>
      <Tabs items={[{ key: 'changes', label: 'Data changes', children: <ChangesTab /> }, { key: 'auth', label: 'Sign-in events', children: <AuthEventsTab /> }]} />
    </>
  );
}

function ChangesTab() {
  const { can } = useAuth();
  const [form] = Form.useForm<Filters>();
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [record, setRecord] = useState<{ table: string; id: string } | null>(null);

  const tables = useQuery({ queryKey: ['audit', 'tables'], queryFn: () => api<string[]>('/core/audit-log/tables') });
  const users = useQuery({
    queryKey: ['users', 'all'],
    queryFn: () => api<Page<UserDto>>('/core/users?pageSize=200'),
    enabled: can('core.user.manage'),
  });
  const params = {
    table: filters.table,
    recordId: filters.recordId,
    userId: filters.userId,
    action: filters.action,
    from: filters.range ? toBusinessDate(filters.range[0]) : undefined,
    to: filters.range ? toBusinessDate(filters.range[1]) : undefined,
    page,
    pageSize: 50,
  };
  const log = useQuery({ queryKey: ['audit', params], queryFn: () => api<Page<AuditEntryDto>>(`/core/audit-log?${query(params)}`) });

  return (
    <>
      <Form
        form={form}
        layout="inline"
        onFinish={(v) => {
          setFilters(v);
          setPage(1);
        }}
        style={{ marginBottom: 12, rowGap: 8 }}
      >
        <Form.Item name="table"><Select allowClear placeholder="Table" style={{ width: 220 }} showSearch options={(tables.data ?? []).map((t) => ({ value: t, label: t }))} /></Form.Item>
        <Form.Item name="recordId" rules={[{ pattern: /^\d+$/, message: 'Number' }]}><Input placeholder="Record id" style={{ width: 110 }} /></Form.Item>
        {can('core.user.manage') && (
          <Form.Item name="userId">
            <Select allowClear showSearch optionFilterProp="label" placeholder="Changed by" style={{ width: 200 }}
              options={(users.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.fullName} (${u.username})` }))} />
          </Form.Item>
        )}
        <Form.Item name="action"><Select allowClear placeholder="Action" style={{ width: 120 }} options={['INSERT', 'UPDATE', 'DELETE'].map((a) => ({ value: a, label: a }))} /></Form.Item>
        <Form.Item name="range"><DatePicker.RangePicker format="DD-MM-YYYY" /></Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">Filter</Button>
          <Button onClick={() => { form.resetFields(); setFilters({}); setPage(1); }}>Clear</Button>
        </Space>
      </Form>
      <Table<AuditEntryDto>
        rowKey="id"
        size="small"
        loading={log.isLoading}
        dataSource={log.data?.items ?? []}
        pagination={{ current: page, pageSize: 50, total: log.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
        scroll={{ x: true }}
        columns={[
          { title: 'When', render: (_, e) => formatDateTime(e.changedAt), width: 150 },
          { title: 'Table', dataIndex: 'table' },
          { title: 'Record', render: (_, e) => <Typography.Link onClick={() => setRecord({ table: e.table, id: e.recordId })}>{e.recordId}</Typography.Link> },
          { title: 'Action', render: (_, e) => <Tag color={e.action === 'INSERT' ? 'green' : e.action === 'DELETE' ? 'red' : 'blue'}>{e.action}</Tag> },
          { title: 'By', render: (_, e) => (e.changedBy ? `${e.changedBy.fullName} (${e.changedBy.username})` : 'system') },
          { title: 'Reason', dataIndex: 'reason' },
          { title: 'Fields', render: (_, e) => (e.action === 'UPDATE' ? e.changes.map((c) => c.field).join(', ') : '') },
        ]}
        expandable={{
          expandedRowRender: (e) =>
            e.action === 'UPDATE' ? (
              <Table size="small" pagination={false} rowKey="field" dataSource={e.changes}
                columns={[
                  { title: 'Field', dataIndex: 'field' },
                  { title: 'Old value', render: (_, c) => <Typography.Text delete>{show(c.old)}</Typography.Text> },
                  { title: 'New value', render: (_, c) => show(c.new) },
                ]} />
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(e.newData ?? e.oldData, null, 2)}</pre>
            ),
        }}
      />
      <RecordDrawer record={record} onClose={() => setRecord(null)} />
    </>
  );
}

function RecordDrawer({ record, onClose }: { record: { table: string; id: string } | null; onClose(): void }) {
  const q = record ? query({ table: record.table, recordId: record.id }) : '';
  const history = useQuery({ queryKey: ['status-history', q], queryFn: () => api<StatusHistoryDto[]>(`/core/status-history?${q}`), enabled: record !== null });
  const signatures = useQuery({ queryKey: ['e-signatures', q], queryFn: () => api<ESignatureDto[]>(`/core/e-signatures?${q}`), enabled: record !== null });
  return (
    <Drawer open={record !== null} onClose={onClose} width={520} title={record ? `${record.table} #${record.id}` : ''}>
      <Typography.Title level={5}>Status history</Typography.Title>
      {history.data?.length ? (
        <Timeline
          items={history.data.map((h) => ({
            children: (
              <>
                {h.fromStatus ? <StatusTag status={h.fromStatus} /> : <Tag>new</Tag>} → <StatusTag status={h.toStatus} />
                <div style={{ fontSize: 12 }}>{h.actor.fullName}, {formatDateTime(h.at)}</div>
                {h.reason && <div style={{ fontSize: 12 }}>Reason: {h.reason}</div>}
                {h.signature && <div style={{ fontSize: 12 }}>Signed {h.signature.meaning} by {h.signature.signerName}</div>}
                {h.witness && <div style={{ fontSize: 12 }}>Witnessed by {h.witness.signerName}</div>}
              </>
            ),
          }))}
        />
      ) : (
        <Typography.Paragraph type="secondary">This record has no status history.</Typography.Paragraph>
      )}
      <Typography.Title level={5}>E-signatures</Typography.Title>
      <Table<ESignatureDto> size="small" rowKey="id" pagination={false} dataSource={signatures.data ?? []}
        columns={[
          { title: 'Signed', render: (_, s) => formatDateTime(s.signedAt) },
          { title: 'By', render: (_, s) => `${s.signerName} (${s.signerUsername})` },
          { title: 'Meaning', render: (_, s) => <Tag color="blue">{s.meaning}</Tag> },
          { title: 'Reason', dataIndex: 'reason' },
        ]} />
    </Drawer>
  );
}

function AuthEventsTab() {
  const [event, setEvent] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const params = { event, page, pageSize: 50 };
  const events = useQuery({ queryKey: ['auth-events', params], queryFn: () => api<Page<AuthEventDto>>(`/core/auth-events?${query(params)}`) });
  return (
    <>
      <Select allowClear placeholder="Event" style={{ width: 200, marginBottom: 12 }} value={event}
        onChange={(v) => { setEvent(v); setPage(1); }}
        options={['LOGIN_OK', 'LOGIN_FAIL', 'LOGOUT', 'LOCKOUT', 'UNLOCK', 'PASSWORD_CHANGE', 'ESIGN_FAIL', 'TOKEN_REUSE'].map((e) => ({ value: e, label: e }))} />
      <Table<AuthEventDto>
        rowKey="id"
        size="small"
        loading={events.isLoading}
        dataSource={events.data?.items ?? []}
        pagination={{ current: page, pageSize: 50, total: events.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
        scroll={{ x: true }}
        columns={[
          { title: 'When', render: (_, e) => formatDateTime(e.at), width: 150 },
          { title: 'Event', render: (_, e) => <Tag color={/FAIL|LOCKOUT|REUSE/.test(e.event) ? 'red' : 'default'}>{e.event}</Tag> },
          { title: 'Employee code', dataIndex: 'username' },
          { title: 'IP', dataIndex: 'ip' },
          { title: 'Details', render: (_, e) => (e.details ? show(e.details) : '') },
        ]}
      />
    </>
  );
}
