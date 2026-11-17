// "My approvals": steps waiting for one of my roles (never my own documents). Approve/reject = e-signature.
import { useState } from 'react';
import { App, Button, Descriptions, Drawer, Space, Table, Timeline, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDto, InboxItemDto, Page } from '@albert/shared';
import { api, newIdempotencyKey } from '../../api/client';
import { ESignModal, type ESignResult } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, formatDecimal, formatPKR } from '../../lib/format';

function valueText(v: { measure: string; measuredValue: string | null; amount?: string | null; currency?: string | null }): string {
  if (v.measure === 'NONE' || v.measuredValue === null) return '—';
  if (v.measure === 'PERCENT') return `${formatDecimal(v.measuredValue, 2)} %`;
  const pkr = formatPKR(v.measuredValue);
  return v.currency && v.amount ? `${v.currency} ${formatDecimal(v.amount)} (${pkr})` : pkr;
}

export function InboxPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);

  const inbox = useQuery({
    queryKey: ['approvals', 'inbox', page],
    queryFn: () => api<Page<InboxItemDto>>(`/core/approvals/inbox?page=${page}&pageSize=25`),
  });
  const detail = useQuery({
    queryKey: ['approvals', openId],
    queryFn: () => api<ApprovalDto>(`/core/approvals/${openId}`),
    enabled: openId !== null,
  });

  const decide = useMutation({
    mutationFn: async (r: ESignResult) => {
      if (!openId || !decision) return;
      await api<ApprovalDto>(`/core/approvals/${openId}/${decision}`, {
        method: 'POST',
        body: { signature: r.signature },
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      void message.success(decision === 'approve' ? 'Approved' : 'Rejected');
      setDecision(null);
      setOpenId(null);
      await qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const a = detail.data;
  return (
    <>
      <PageHeader title="My approvals">Documents waiting for a role you hold. Your own documents never appear here.</PageHeader>
      <Table<InboxItemDto>
        rowKey="approvalId"
        loading={inbox.isLoading}
        dataSource={inbox.data?.items ?? []}
        pagination={{ current: page, pageSize: 25, total: inbox.data?.total ?? 0, onChange: setPage }}
        onRow={(r) => ({ onClick: () => setOpenId(r.approvalId), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Document', render: (_, r) => <Typography.Link>{r.docNo ?? `${r.docType} #${r.docId}`}</Typography.Link> },
          { title: 'Type', dataIndex: 'docType' },
          { title: 'Value', render: (_, r) => valueText(r) },
          { title: 'Your role', dataIndex: 'roleCode' },
          { title: 'Step', dataIndex: 'stepNo', width: 70 },
          { title: 'Requested by', dataIndex: 'requestedBy' },
          { title: 'Requested', render: (_, r) => formatDateTime(r.requestedAt) },
        ]}
        locale={{ emptyText: 'Nothing waiting for you' }}
        scroll={{ x: true }}
      />

      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width={520} title={a ? (a.docNo ?? `${a.docType} #${a.docId}`) : 'Approval'}>
        {a && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="Status"><StatusTag status={a.status} /></Descriptions.Item>
              <Descriptions.Item label="Document type">{a.docType}</Descriptions.Item>
              <Descriptions.Item label="Value">{valueText(a)}</Descriptions.Item>
              {a.exchangeRate && <Descriptions.Item label="Exchange rate">{formatDecimal(a.exchangeRate, 4)}</Descriptions.Item>}
              <Descriptions.Item label="Requested by">{a.requestedBy.fullName}</Descriptions.Item>
              <Descriptions.Item label="Requested">{formatDateTime(a.createdAt)}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5} style={{ marginTop: 16 }}>Steps</Typography.Title>
            <Timeline
              items={a.steps.map((s) => ({
                color: s.status === 'APPROVED' ? 'green' : s.status === 'REJECTED' ? 'red' : s.status === 'PENDING' ? 'blue' : 'gray',
                children: (
                  <>
                    Step {s.stepNo} · {s.roleName} <StatusTag status={s.status} />
                    {s.actedBy && (
                      <div style={{ fontSize: 12, color: '#888' }}>
                        {s.actedBy}, {formatDateTime(s.actedAt)}
                      </div>
                    )}
                  </>
                ),
              }))}
            />
            {a.status === 'PENDING' && (
              <Space>
                <Button type="primary" onClick={() => setDecision('approve')}>Approve</Button>
                <Button danger onClick={() => setDecision('reject')}>Reject</Button>
              </Space>
            )}
          </>
        )}
      </Drawer>

      <ESignModal
        open={decision !== null}
        title={decision === 'approve' ? 'Approve with e-signature' : 'Reject with e-signature'}
        meaning={decision === 'approve' ? 'APPROVED' : 'REJECTED'}
        summary={a ? `${decision === 'approve' ? 'Approve' : 'Reject'} ${a.docNo ?? a.docType} (${valueText(a)}).` : undefined}
        okText={decision === 'approve' ? 'Approve' : 'Reject'}
        onCancel={() => setDecision(null)}
        onSubmit={(r) => decide.mutateAsync(r)}
      />
    </>
  );
}
