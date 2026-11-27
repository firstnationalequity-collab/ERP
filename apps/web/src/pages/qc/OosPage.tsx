// OOS investigations (M4 task 4b; owner 2026-11-27; 0040). An investigation opens automatically when a failed result
// is reviewed. While it is open the result is not re-tested and the lot is not approved (rejection stays possible).
// The QC Manager (qc.oos.close), never the analyst who entered the failed result, closes it with an e-signature:
// INVALIDATED (assignable cause: category + description; a re-test is then allowed) or CONFIRMED (the failure stands).
import { useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Input, Radio, Select, Space, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OosCauseCategory, type OosDto, type OosOutcome } from '@albert/shared';
import { api } from '../../api/client';
import { DataTable, statusFilter } from '../../components/DataTable';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime } from '../../lib/format';

const queryKey = ['qc', 'oos'];
const label = (s: string) => s.replace(/_/g, ' ');

export function OosPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="OOS investigations">
        Opened automatically when a failed result is reviewed. While one is open, the test is not re-tested and the lot is not approved. The QC Manager closes it with an
        e-signature: invalidated (assignable cause found, the test may be re-tested) or confirmed (the failure stands).
      </PageHeader>
      <DataTable<OosDto>
        title="OOS investigations"
        path="/qc/oos"
        queryKey={queryKey}
        filters={[statusFilter(['OPEN', 'CLOSED'] as const)]}
        searchPlaceholder="Search OOS number, lot number, item code or name"
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'docNo', title: 'OOS' },
          { key: 'status', title: 'Status', render: (r) => <StatusTag status={r.status} /> },
          { key: 'outcome', title: 'Outcome', render: (r) => (r.outcome ? <StatusTag status={r.outcome} /> : '—'), exportValue: (r) => r.outcome ?? '' },
          { key: 'lotNo', title: 'Lot' },
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'testName', title: 'Test', render: (r) => `${r.testName}: ${r.resultValue ?? ''} (limit ${r.limit})`, exportValue: (r) => `${r.testName}: ${r.resultValue ?? ''} (limit ${r.limit})` },
          { key: 'openedAt', title: 'Opened', render: (r) => formatDateTime(r.openedAt), exportValue: (r) => formatDateTime(r.openedAt) },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpenId(r.id)}>Open</Button>}
      />
      {openId && <OosDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function OosDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: o, refetch } = useQuery({ queryKey: [...queryKey, 'one', id], queryFn: () => api<OosDto>(`/qc/oos/${id}`) });
  const [outcome, setOutcome] = useState<OosOutcome | null>(null);
  const [category, setCategory] = useState<OosCauseCategory | null>(null);
  const [description, setDescription] = useState('');
  const [signing, setSigning] = useState(false);
  const described = description.trim().length >= 10;
  const ready = outcome === 'CONFIRMED' ? description.trim() === '' || described : outcome === 'INVALIDATED' && category !== null && described;

  return (
    <Drawer open width={820} title={o ? `OOS investigation ${o.docNo}` : 'OOS investigation'} onClose={onClose}>
      {o && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Status">
              <StatusTag status={o.status} /> {o.outcome && <StatusTag status={o.outcome} />}
            </Descriptions.Item>
            <Descriptions.Item label="Lot">
              {o.lotNo} <StatusTag status={o.lotStatus} />
            </Descriptions.Item>
            <Descriptions.Item label="Item">{`${o.itemCode} — ${o.itemName} (${o.itemType})`}</Descriptions.Item>
            <Descriptions.Item label="Sample request">{o.sampleRequestId}</Descriptions.Item>
            <Descriptions.Item label="Test">{o.testName}</Descriptions.Item>
            <Descriptions.Item label="Limit">{o.limit}</Descriptions.Item>
            <Descriptions.Item label="Failed result">{o.resultValue ?? '—'}{o.resultRemarks ? ` · ${o.resultRemarks}` : ''}</Descriptions.Item>
            <Descriptions.Item label="Entered by">{`${o.enteredByName} · ${formatDateTime(o.enteredAt)}`}</Descriptions.Item>
            <Descriptions.Item label="Opened by (review)">{`${o.openedByName} · ${formatDateTime(o.openedAt)}`}</Descriptions.Item>
            <Descriptions.Item label="Re-test">{o.retestResultId ? `result ${o.retestResultId}` : '—'}</Descriptions.Item>
            {o.status === 'CLOSED' && (
              <>
                <Descriptions.Item label="Closed by">{`${o.closedByName ?? ''} · ${formatDateTime(o.closedAt)}`}</Descriptions.Item>
                <Descriptions.Item label="Conclusion (signature reason)">{o.conclusion}</Descriptions.Item>
                <Descriptions.Item label="Assignable cause">{o.causeCategory ? label(o.causeCategory) : '—'}</Descriptions.Item>
                <Descriptions.Item label="Findings">{o.causeDescription ?? '—'}</Descriptions.Item>
              </>
            )}
          </Descriptions>
          {o.status === 'OPEN' && (
            <Alert
              type="warning"
              showIcon
              message="Investigation open"
              description="The test is not re-tested and the lot is not approved until this investigation is closed. The lot may still be rejected."
            />
          )}
          {o.status === 'CLOSED' && o.outcome === 'INVALIDATED' && !o.retestResultId && (
            <Alert type="info" showIcon message="Result invalidated: the analyst may now re-test this test (Sample queue)." />
          )}
          {o.status === 'CLOSED' && o.outcome === 'CONFIRMED' && (
            <Alert
              type="info"
              showIcon
              message={o.itemType === 'FG' ? 'Failure confirmed: the finished-goods lot stays on HOLD for QA.' : 'Failure confirmed: the material lot can only be rejected.'}
            />
          )}
          {o.canClose && (
            <Space direction="vertical" style={{ width: 600 }}>
              <Typography.Text strong>Close the investigation</Typography.Text>
              <Radio.Group value={outcome} onChange={(e) => setOutcome(e.target.value as OosOutcome)}>
                <Radio value="INVALIDATED">Invalidated — assignable cause found</Radio>
                <Radio value="CONFIRMED">Confirmed — the failure stands</Radio>
              </Radio.Group>
              {outcome === 'INVALIDATED' && (
                <Select<OosCauseCategory>
                  aria-label="Assignable cause"
                  placeholder="Assignable cause"
                  value={category ?? undefined}
                  onChange={(v) => setCategory(v)}
                  options={OosCauseCategory.map((c) => ({ value: c, label: label(c) }))}
                />
              )}
              {outcome !== null && (
                <Input.TextArea
                  aria-label="Findings"
                  rows={4}
                  maxLength={2000}
                  placeholder={outcome === 'INVALIDATED' ? 'Describe the assignable cause (at least 10 characters)' : 'Findings (optional, at least 10 characters if given)'}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
              <Button type="primary" disabled={!ready} onClick={() => setSigning(true)}>
                Close with e-signature
              </Button>
            </Space>
          )}
          {o.status === 'OPEN' && !o.canClose && (
            <Typography.Text type="secondary">A QC Manager who did not enter the failed result closes this investigation.</Typography.Text>
          )}
        </Space>
      )}
      <ESignModal
        open={signing}
        title={o ? `Close ${o.docNo}` : 'Close investigation'}
        meaning="APPROVED"
        summary={o && outcome ? `You close ${o.docNo} as ${outcome}. ${outcome === 'INVALIDATED' ? 'The failed result is invalidated and may be re-tested.' : 'The failure stands; the test is not re-tested.'} The reason you give is the conclusion.` : ''}
        okText="Close investigation"
        onCancel={() => setSigning(false)}
        onSubmit={async (r) => {
          await api(`/qc/oos/${id}/close`, {
            method: 'POST',
            body: {
              outcome,
              ...(outcome === 'INVALIDATED' && category ? { causeCategory: category } : {}),
              ...(description.trim() ? { causeDescription: description.trim() } : {}),
              signature: r.signature,
            },
          });
          void message.success('Investigation closed');
          setSigning(false);
          await refetch();
          await qc.invalidateQueries({ queryKey });
          await qc.invalidateQueries({ queryKey: ['qc'] });
        }}
      />
    </Drawer>
  );
}
