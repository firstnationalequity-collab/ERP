// "My approvals": steps waiting for one of my roles (never my own documents). Approve/reject = e-signature.
// A document may raise a warning the approver must acknowledge (vendor payment: FILER_CHECK_STALE, task 5b).
import { useState } from 'react';
import { Alert, App, Button, Checkbox, Descriptions, Drawer, Space, Table, Timeline, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDto, ApprovedSourceDto, FormulaDto, InboxItemDto, Page, VendorPaymentDto } from '@albert/shared';
import { AttachmentList } from '../../components/Attachments';
import { RefLabel } from '../../components/RefSelect';
import { FormulaLinesTable } from '../master/FormulasPage';
import { api, newIdempotencyKey } from '../../api/client';
import { ESignModal, type ESignResult } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDate, formatDateTime, formatDecimal, formatPKR } from '../../lib/format';

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
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

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
        body: decision === 'approve' && acknowledged.length ? { signature: r.signature, acknowledgements: acknowledged } : { signature: r.signature },
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: async () => {
      void message.success(decision === 'approve' ? 'Approved' : 'Rejected');
      setDecision(null);
      setOpenId(null);
      setAcknowledged([]);
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
        onRow={(r) => ({ onClick: () => { setOpenId(r.approvalId); setAcknowledged([]); }, style: { cursor: 'pointer' } })}
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

      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width={720} title={a ? (a.docNo ?? `${a.docType} #${a.docId}`) : 'Approval'}>
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
            <ApprovalDocument approval={a} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
            {(a.attachments.length > 0 || a.docType === 'AVL') && (
              <>
                <Typography.Title level={5} style={{ marginTop: 16 }}>Attachments</Typography.Title>
                <AttachmentList items={a.attachments} />
              </>
            )}
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

/** What is being approved, for the document types that have a detail view (AVL source, master formula, vendor payment). */
function ApprovalDocument({ approval, acknowledged, onAcknowledge }: { approval: ApprovalDto; acknowledged: string[]; onAcknowledge: (codes: string[]) => void }) {
  const payment = useQuery({
    queryKey: ['approvals', 'doc', 'VENDOR_PAYMENT', approval.docId],
    queryFn: () => api<VendorPaymentDto>(`/purch/vendor-payments/${approval.docId}`),
    enabled: approval.docType === 'VENDOR_PAYMENT',
  });
  const avl = useQuery({
    queryKey: ['approvals', 'doc', 'AVL', approval.docId],
    queryFn: () => api<ApprovedSourceDto>(`/master/approved-sources/${approval.docId}`),
    enabled: approval.docType === 'AVL',
  });
  const formula = useQuery({
    queryKey: ['approvals', 'doc', 'MASTER_FORMULA', approval.docId],
    queryFn: () => api<FormulaDto>(`/master/formulas/${approval.docId}`),
    enabled: approval.docType === 'MASTER_FORMULA',
  });
  if (approval.docType === 'AVL' && avl.data) {
    const s = avl.data;
    return (
      <>
        <Typography.Title level={5} style={{ marginTop: 16 }}>Approved source</Typography.Title>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Vendor">{s.vendorCode} — {s.vendorName}</Descriptions.Item>
          <Descriptions.Item label="Item">{s.itemCode} — {s.itemName}</Descriptions.Item>
          <Descriptions.Item label="Manufacturer">{s.manufacturer}</Descriptions.Item>
          <Descriptions.Item label="Site">{s.manufacturingSite}</Descriptions.Item>
          {s.notes && <Descriptions.Item label="Notes">{s.notes}</Descriptions.Item>}
        </Descriptions>
        {approval.attachments.length === 0 && (
          <Typography.Paragraph type="warning" style={{ marginTop: 8 }}>
            No evidence is attached yet; the approval is refused until the proposer attaches it.
          </Typography.Paragraph>
        )}
      </>
    );
  }
  if (approval.docType === 'MASTER_FORMULA' && formula.data) {
    const f = formula.data;
    return (
      <>
        <Typography.Title level={5} style={{ marginTop: 16 }}>Master formula</Typography.Title>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Product">{f.productItemCode} — {f.productItemName}</Descriptions.Item>
          <Descriptions.Item label="Version">{f.version}</Descriptions.Item>
          <Descriptions.Item label="Batch size">{formatDecimal(f.batchSize, 4)} <RefLabel path="/master/uoms" id={f.batchUomId} /></Descriptions.Item>
          {f.notes && <Descriptions.Item label="Notes">{f.notes}</Descriptions.Item>}
        </Descriptions>
        <div style={{ marginTop: 8 }}>
          <FormulaLinesTable lines={f.lines ?? []} />
        </div>
      </>
    );
  }
  if (approval.docType === 'VENDOR_PAYMENT' && payment.data) {
    const p = payment.data;
    return (
      <>
        <Typography.Title level={5} style={{ marginTop: 16 }}>Vendor payment</Typography.Title>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="Vendor">{p.vendorCode} — {p.vendorName}</Descriptions.Item>
          <Descriptions.Item label="Payment date">{formatDate(p.paymentDate)}</Descriptions.Item>
          <Descriptions.Item label="WHT">{p.whtTaxCode ? `${p.whtTaxCode} at ${formatDecimal(p.whtRate, 4)}%: ${formatDecimal(p.whtAmount)}` : 'None'}</Descriptions.Item>
          <Descriptions.Item label="Filer (ATL)">
            {p.payeeIsFiler === null ? 'Not checked (non-filer rate)' : `${p.payeeIsFiler ? 'Filer' : 'Non-filer'}, checked ${formatDate(p.payeeFilerCheckedOn)}`}
          </Descriptions.Item>
        </Descriptions>
        {p.filerCheckStale && approval.status === 'PENDING' && (
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message={`The vendor's filer status was ${p.payeeFilerCheckedOn ? `last checked on ${formatDate(p.payeeFilerCheckedOn)}` : 'never checked'} (limit ${p.filerCheckMaxDays} days)`}
            description={
              <Checkbox checked={acknowledged.includes('FILER_CHECK_STALE')} onChange={(e) => onAcknowledge(e.target.checked ? ['FILER_CHECK_STALE'] : [])}>
                I have read this warning and approve the WHT rate as shown
              </Checkbox>
            }
          />
        )}
      </>
    );
  }
  return null;
}
