// QC lot disposition (M4 task 3; 0037). The QC Manager approves a sampled material lot once every test has a reviewed,
// passing result (the latest assay and water results are written onto the lot), or rejects it on a failed result;
// a material lot QA put on HOLD may be rejected (only QA lifts a hold). Each decision is an e-signature on the lot
// and closes the sample request. Finished-goods lots are QA's decision and are not listed here.
import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DispositionLotDto, DispositionTestDto, SignatureMeaning } from '@albert/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { companyToday, formatDate, formatDateTime, formatDecimal, toBusinessDate } from '../../lib/format';

const queryKey = ['qc', 'lots'];

export function DispositionPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Lot disposition">
        Material lots under test, and material lots QA put on hold. Approve when every test has a reviewed, passing result; reject on a failed result. Finished-goods
        lots are decided by QA.
      </PageHeader>
      <DataTable<DispositionLotDto>
        title="Lot disposition"
        path="/qc/lots"
        queryKey={queryKey}
        filters={[statusFilter(['UNDER_TEST', 'HOLD'] as const)]}
        searchPlaceholder="Search lot number, item code or name"
        rowKey={(r) => r.lotId}
        onRowClick={(r) => setOpenId(r.lotId)}
        columns={[
          { key: 'lotNo', title: 'Lot' },
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'itemType', title: 'Type' },
          { key: 'lotStatus', title: 'Lot status', render: (r) => <StatusTag status={r.lotStatus} /> },
          { key: 'expiryDate', title: 'Expiry', render: (r) => formatDate(r.expiryDate), exportValue: (r) => formatDate(r.expiryDate) },
          {
            key: 'failedCount',
            title: 'Results',
            render: (r) => (
              <Space size={4} wrap>
                {r.missingCount > 0 && <Tag>{r.missingCount} missing</Tag>}
                {r.unreviewedCount > 0 && <Tag color="gold">{r.unreviewedCount} to review</Tag>}
                {r.failedCount > 0 && <Tag color="red">{r.failedCount} failed</Tag>}
                {r.lotStatus === 'UNDER_TEST' && r.missingCount + r.unreviewedCount + r.failedCount === 0 && <Tag color="green">all passed</Tag>}
              </Space>
            ),
            exportValue: (r) => `${r.missingCount} missing, ${r.unreviewedCount} to review, ${r.failedCount} failed`,
          },
          {
            key: 'canApprove',
            title: 'Ready to',
            render: (r) => [r.canApprove && 'approve', r.canReject && 'reject'].filter(Boolean).join(' / ') || '—',
          },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpenId(r.lotId)}>Open</Button>}
      />
      {openId && <LotDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function LotDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: l, refetch } = useQuery({ queryKey: [...queryKey, 'one', id], queryFn: () => api<DispositionLotDto>(`/qc/lots/${id}`) });
  const [signing, setSigning] = useState<SignatureMeaning | null>(null);
  const [retestDate, setRetestDate] = useState<string | null>(null);
  const reload = async () => {
    await refetch();
    await qc.invalidateQueries({ queryKey });
  };
  const decider = can('qc.lot.change_status');
  const approving = signing === 'APPROVED';

  return (
    <Drawer open width={900} title={l ? `Lot ${l.lotNo} — disposition` : 'Lot disposition'} onClose={onClose}>
      {l && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Item">{`${l.itemCode} — ${l.itemName} (${l.itemType})`}</Descriptions.Item>
            <Descriptions.Item label="Lot">
              {l.lotNo} <StatusTag status={l.lotStatus} />
            </Descriptions.Item>
            <Descriptions.Item label="Sample request">{l.sampleRequestId ? <>{l.sampleRequestId} <StatusTag status={l.sampleStatus ?? 'OPEN'} /></> : '—'}</Descriptions.Item>
            <Descriptions.Item label="Specification">{l.specVersion ? `v${l.specVersion} (pinned)` : '—'}</Descriptions.Item>
            <Descriptions.Item label="Expiry / retest">{`${formatDate(l.expiryDate) || '—'} / ${formatDate(l.retestDate) || '—'}`}</Descriptions.Item>
            <Descriptions.Item label="Assay / water on the lot">{`${formatDecimal(l.assayPct, 4) || '—'} / ${formatDecimal(l.waterPct, 4) || '—'}`}</Descriptions.Item>
          </Descriptions>

          {l.itemType === 'FG' && <Alert type="info" showIcon message="Finished goods: QA decides this lot (release or reject). QC does not approve or reject FG lots." />}
          {l.blockers.length > 0 && (l.lotStatus === 'UNDER_TEST' || l.lotStatus === 'HOLD') && (
            <Alert type="warning" showIcon message="Not every decision is possible yet" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{l.blockers.map((b) => <li key={b}>{b}</li>)}</ul>} />
          )}

          {(l.tests ?? []).length > 0 && <TestsTable tests={l.tests ?? []} />}

          {decider && (l.canApprove || l.canReject) && (
            <Space direction="vertical">
              {l.canApprove && (
                <Typography.Text type="secondary">
                  Approval writes assay {formatDecimal(l.approvalAssayPct ?? null, 4) || '— (no assay test)'} and water {formatDecimal(l.approvalWaterPct ?? null, 4) || '— (no water test)'} onto the lot.
                </Typography.Text>
              )}
              {l.canApprove && (
                <Space>
                  <span>Next retest date{l.retestDateRequired ? ' (required: the retest date is reached)' : ' (optional)'}</span>
                  <DatePicker
                    aria-label="Next retest date"
                    format="DD-MM-YYYY"
                    value={retestDate ? dayjs(retestDate) : null}
                    disabledDate={(d) => toBusinessDate(d) <= companyToday() || (l.expiryDate !== null && toBusinessDate(d) > l.expiryDate)}
                    onChange={(d) => setRetestDate(d ? toBusinessDate(d) : null)}
                  />
                </Space>
              )}
              <Space>
                {l.canApprove && (
                  <Button type="primary" disabled={l.retestDateRequired && !retestDate} onClick={() => setSigning('APPROVED')}>
                    Approve lot
                  </Button>
                )}
                {l.canReject && (
                  <Button danger onClick={() => setSigning('REJECTED')}>
                    Reject lot
                  </Button>
                )}
              </Space>
            </Space>
          )}

          {(l.history ?? []).length > 0 && (
            <div>
              <Typography.Title level={5}>Decisions</Typography.Title>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={l.history ?? []}
                columns={[
                  { title: 'When', render: (_, d) => formatDateTime(d.decidedAt) },
                  { title: 'Decision', render: (_, d) => <>{d.fromStatus} → <StatusTag status={d.decision} /></> },
                  { title: 'By', dataIndex: 'decidedByName' },
                  { title: 'Reason', dataIndex: 'reason' },
                  { title: 'Assay / water', render: (_, d) => (d.decision === 'APPROVED' ? `${formatDecimal(d.assayPct, 4) || '—'} / ${formatDecimal(d.waterPct, 4) || '—'}` : '') },
                  { title: 'New retest', render: (_, d) => formatDate(d.retestDate) },
                ]}
              />
            </div>
          )}

          <ESignModal
            open={signing !== null}
            title={approving ? `Approve lot ${l.lotNo}` : `Reject lot ${l.lotNo}`}
            meaning={signing ?? 'APPROVED'}
            summary={
              approving
                ? `You approve lot ${l.lotNo}: it becomes APPROVED and may be issued.${retestDate ? ` Next retest ${formatDate(retestDate)}.` : ''}`
                : `You reject lot ${l.lotNo}: it becomes REJECTED and can only be destroyed or returned to the vendor.`
            }
            okText={approving ? 'Approve' : 'Reject'}
            onCancel={() => setSigning(null)}
            onSubmit={async (r) => {
              const body = approving ? { signature: r.signature, retestDate } : { signature: r.signature };
              await api(`/qc/lots/${id}/${approving ? 'approve' : 'reject'}`, { method: 'POST', body });
              void message.success(approving ? 'Lot approved' : 'Lot rejected');
              setSigning(null);
              await reload();
            }}
          />
        </Space>
      )}
    </Drawer>
  );
}

function TestsTable({ tests }: { tests: DispositionTestDto[] }) {
  return (
    <Table<DispositionTestDto>
      rowKey="specTestId"
      size="small"
      pagination={false}
      dataSource={tests}
      columns={[
        { title: 'Test', render: (_, t) => <>{t.name} {t.isAssay && <Tag>assay</Tag>}{t.isWater && <Tag>water</Tag>}</> },
        { title: 'Limit', dataIndex: 'limit' },
        { title: 'Latest result', render: (_, t) => (t.value === null ? '—' : t.resultType === 'NUMERIC' ? t.value.replace(/\.?0+$/, '') : t.value) },
        { title: 'Pass', render: (_, t) => (t.passed === null ? <Tag>no result</Tag> : <Tag color={t.passed ? 'green' : 'red'}>{t.passed ? 'PASS' : 'FAIL'}</Tag>) },
        { title: 'Reviewed', render: (_, t) => (t.resultId === null ? '' : t.reviewed ? 'Yes' : <Tag color="gold">not yet</Tag>) },
      ]}
    />
  );
}
