// QC sample queue and results (M4 task 2). The QC Analyst takes the sample of an OPEN request (the test quantity and
// any retention quantity leave the lot's stock; the lot becomes UNDER_TEST; the APPROVED spec version is pinned),
// then enters one result per test: numeric pass / fail is computed from the limits, text results are judged by the
// analyst. A failed result on a finished-goods lot puts the lot on HOLD for QA. A QC Manager who did not enter the
// results reviews them with an e-signature (REVIEWED). Results are never edited: a re-test is a new row with a reason
// (task 4, 0039); the newest row of a test is its latest result, earlier rows stay listed as superseded.
import { useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EnterResultsRequest, RetestResultRequest, SampleRequestStatus, TakeSampleRequest, type ResultDto, type SampleRequestDto, type SpecTestDto } from '@albert/shared';
import { api, errorText, newIdempotencyKey } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable, statusFilter } from '../../components/DataTable';
import { ESignModal } from '../../components/ESignModal';
import { PageHeader } from '../../components/PageHeader';
import { StatusTag } from '../../components/StatusTag';
import { formatDate, formatDateTime, formatDecimal } from '../../lib/format';
import { limitText } from './SpecsPage';

const queryKey = ['qc', 'samples'];

export function SamplesPage({ reviewQueue = false }: { reviewQueue?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title={reviewQueue ? 'QC review queue' : 'QC sample queue'}>
        {reviewQueue
          ? 'Samples with results not yet reviewed. The reviewer is never the analyst who entered a result, and signs the review.'
          : 'Lots waiting for sampling and under test. Taking a sample removes the sample quantity from stock and puts the lot UNDER_TEST.'}
      </PageHeader>
      <DataTable<SampleRequestDto>
        title={reviewQueue ? 'QC review queue' : 'QC sample queue'}
        path="/qc/samples"
        queryKey={[...queryKey, reviewQueue]}
        params={reviewQueue ? { toReview: 'true' } : {}}
        filters={reviewQueue ? [] : [statusFilter(SampleRequestStatus)]}
        searchPlaceholder="Search lot number, item code or name"
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'id', title: 'Request' },
          { key: 'lotNo', title: 'Lot' },
          { key: 'itemCode', title: 'Item', render: (r) => `${r.itemCode} — ${r.itemName}`, exportValue: (r) => `${r.itemCode} — ${r.itemName}` },
          { key: 'itemType', title: 'Type' },
          { key: 'refDocType', title: 'From', render: (r) => (r.refDocType === 'GRN' ? 'GRN' : 'FG output') },
          { key: 'requestedAt', title: 'Requested', render: (r) => formatDateTime(r.requestedAt), exportValue: (r) => formatDateTime(r.requestedAt) },
          { key: 'status', title: 'Request', render: (r) => <StatusTag status={r.status} /> },
          { key: 'lotStatus', title: 'Lot status', render: (r) => <StatusTag status={r.lotStatus} /> },
          {
            key: 'resultCount',
            title: 'Results',
            render: (r) => (
              <Space size={4}>
                {r.resultCount}
                {r.failedCount > 0 && <Tag color="red">{r.failedCount} failed</Tag>}
                {r.unreviewedCount > 0 && <Tag color="gold">{r.unreviewedCount} to review</Tag>}
              </Space>
            ),
            exportValue: (r) => `${r.resultCount} (${r.failedCount} failed, ${r.unreviewedCount} to review)`,
          },
        ]}
        actions={(r) => <Button type="link" onClick={() => setOpenId(r.id)}>Open</Button>}
      />
      {openId && <SampleDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function SampleDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: s, refetch } = useQuery({ queryKey: [...queryKey, 'one', id], queryFn: () => api<SampleRequestDto>(`/qc/samples/${id}`) });
  const [reviewing, setReviewing] = useState(false);
  const reload = async () => {
    await refetch();
    await qc.invalidateQueries({ queryKey });
  };
  const name = (u: string | null) => (u ? (s?.userNames[u] ?? u) : '—');

  return (
    <Drawer open width={980} title={s ? `Sample request ${s.id} — lot ${s.lotNo}` : 'Sample request'} onClose={onClose}>
      {s && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Item">{`${s.itemCode} — ${s.itemName} (${s.itemType})`}</Descriptions.Item>
            <Descriptions.Item label="Lot">
              {s.lotNo} <StatusTag status={s.lotStatus} />
            </Descriptions.Item>
            <Descriptions.Item label="Request">
              <StatusTag status={s.status} /> from {s.refDocType === 'GRN' ? `GRN ${s.refDocId}` : `FG output ${s.refDocId}`}
            </Descriptions.Item>
            <Descriptions.Item label="Expiry / retest">{`${formatDate(s.expiryDate) || '—'} / ${formatDate(s.retestDate) || '—'}`}</Descriptions.Item>
            {s.status !== 'OPEN' && (
              <>
                <Descriptions.Item label="Specification">{s.specVersion ? `v${s.specVersion} (pinned)` : '—'}</Descriptions.Item>
                <Descriptions.Item label="Sampled">{`${name(s.sampledBy)}, ${formatDateTime(s.sampledAt)}`}</Descriptions.Item>
                <Descriptions.Item label="Test quantity">{formatDecimal(s.testQty, 4)}</Descriptions.Item>
                <Descriptions.Item label="Retention quantity">{formatDecimal(s.retentionQty, 4)}</Descriptions.Item>
                {s.sampleNotes && <Descriptions.Item label="Notes" span={2}>{s.sampleNotes}</Descriptions.Item>}
              </>
            )}
          </Descriptions>
          {s.itemType === 'FG' && s.lotStatus === 'HOLD' && (
            <Alert type="warning" showIcon message="A result failed: this finished-goods lot is on HOLD. QA decides after the investigation; QC does not reject FG lots." />
          )}
          {s.status === 'OPEN' && can('qc.result.enter') && <TakeSample s={s} onDone={reload} />}
          {s.status === 'SAMPLED' && (
            <ResultsTable s={s} canEnter={can('qc.result.enter') && (s.lotStatus === 'UNDER_TEST' || (s.itemType === 'FG' && s.lotStatus === 'HOLD'))} name={name} onDone={reload} />
          )}
          {s.status === 'OPEN' && (s.tests ?? []).length === 0 && <Alert type="error" showIcon message="This item has no APPROVED specification: QC approves one before the lot is sampled." />}
          {s.status === 'SAMPLED' && can('qc.result.review') && s.unreviewedCount > 0 && (
            <Button type="primary" onClick={() => setReviewing(true)}>
              Review {s.unreviewedCount} result(s)
            </Button>
          )}
          <ESignModal
            open={reviewing}
            title="Review QC results"
            meaning="REVIEWED"
            summary={`You confirm you checked the raw data of ${s.unreviewedCount} result(s) on lot ${s.lotNo}.`}
            okText="Review"
            onCancel={() => setReviewing(false)}
            onSubmit={async (r) => {
              await api(`/qc/samples/${id}/review`, { method: 'POST', body: { signature: r.signature } });
              void message.success('Results reviewed');
              setReviewing(false);
              await reload();
            }}
          />
        </Space>
      )}
    </Drawer>
  );
}

function TakeSample({ s, onDone }: { s: SampleRequestDto; onDone(): Promise<void> }) {
  const { message } = App.useApp();
  const locations = s.locations ?? [];
  const [locationId, setLocationId] = useState<string | undefined>(locations[0]?.locationId);
  const [testQty, setTestQty] = useState<string | null>(null);
  const [retentionQty, setRetentionQty] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);

  const submit = async () => {
    const parsed = TakeSampleRequest.safeParse({ locationId, testQty: testQty ?? '', retentionQty: retentionQty || null, notes: notes.trim() || null });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/qc/samples/${s.id}/take`, { method: 'POST', body: parsed.data, idempotencyKey: key });
      void message.success('Sample taken; the lot is UNDER_TEST');
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Typography.Title level={5}>Take the sample</Typography.Title>
      <Typography.Paragraph type="secondary">
        The quantities leave the lot's stock at the chosen location today (QC sample expense). Retention / reserve samples are kept by QC.
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Space wrap>
        <Select
          aria-label="Location"
          style={{ width: 240 }}
          value={locationId}
          onChange={setLocationId}
          placeholder="Location"
          options={locations.map((l) => ({ value: l.locationId, label: `${l.locationCode} (holds ${formatDecimal(l.qty, 4)})` }))}
        />
        <InputNumber<string> aria-label="Test quantity" stringMode min="0" placeholder="Test quantity" value={testQty} onChange={setTestQty} style={{ width: 160 }} />
        <InputNumber<string> aria-label="Retention quantity" stringMode min="0" placeholder="Retention (optional)" value={retentionQty} onChange={setRetentionQty} style={{ width: 180 }} />
        <Input aria-label="Notes" placeholder="Notes (sampling plan, containers)" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: 280 }} />
        <Button type="primary" loading={busy} onClick={() => void submit()} disabled={(s.tests ?? []).length === 0}>
          Take sample
        </Button>
      </Space>
    </div>
  );
}

type Draft = { value: string; complies?: boolean; remarks: string };

function ResultsTable({ s, canEnter, name, onDone }: { s: SampleRequestDto; canEnter: boolean; name(u: string | null): string; onDone(): Promise<void> }) {
  const { message } = App.useApp();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retesting, setRetesting] = useState<{ test: SpecTestDto; result: ResultDto } | null>(null);
  // Results come oldest first, so each test maps to its newest row (its latest result).
  const byTest = new Map((s.results ?? []).map((r) => [r.specTestId, r]));
  const superseded = (s.results ?? []).filter((r) => r.superseded);
  const testName = (id: string) => (s.tests ?? []).find((t) => t.id === id)?.name ?? id;
  const set = (testId: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [testId]: { value: '', remarks: '', ...d[testId], ...patch } }));

  const save = async () => {
    const tests = new Map((s.tests ?? []).map((t) => [t.id, t]));
    const results = Object.entries(drafts)
      .filter(([testId, d]) => !byTest.has(testId) && (d.value.trim() !== '' || d.complies !== undefined))
      .map(([testId, d]) =>
        tests.get(testId)?.resultType === 'NUMERIC'
          ? { specTestId: testId, numericValue: d.value.trim(), remarks: d.remarks.trim() || null }
          : { specTestId: testId, textValue: d.value.trim(), complies: d.complies ?? null, remarks: d.remarks.trim() || null },
      );
    const parsed = EnterResultsRequest.safeParse({ results });
    if (!parsed.success) {
      setError(results.length === 0 ? 'Enter at least one result' : parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/qc/samples/${s.id}/results`, { method: 'POST', body: parsed.data });
      void message.success('Results saved');
      setDrafts({});
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const resultText = (r: ResultDto) => (r.resultType === 'NUMERIC' ? formatDecimal(r.numericValue, 6).replace(/\.?0+$/, '') : (r.textValue ?? ''));

  return (
    <div>
      <Typography.Title level={5}>Results</Typography.Title>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Table<SpecTestDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={s.tests ?? []}
        scroll={{ x: true }}
        columns={[
          { title: '#', dataIndex: 'seq', width: 40 },
          { title: 'Test', dataIndex: 'name' },
          { title: 'Limit', render: (_, t) => limitText(t) },
          {
            title: 'Result',
            width: 260,
            render: (_, t) => {
              const r = byTest.get(t.id);
              if (r) {
                return (
                  <Space size={4} wrap>
                    {resultText(r)}
                    {r.retestOf && <Tag title={r.retestReason ?? ''}>re-test</Tag>}
                    {canEnter && (
                      <Button size="small" type="link" onClick={() => setRetesting({ test: t, result: r })}>
                        Re-test
                      </Button>
                    )}
                  </Space>
                );
              }
              if (!canEnter) return '—';
              const d = drafts[t.id];
              return t.resultType === 'NUMERIC' ? (
                <Input aria-label={`${t.name} result`} inputMode="decimal" value={d?.value ?? ''} onChange={(e) => set(t.id, { value: e.target.value })} suffix={t.unit ?? undefined} />
              ) : (
                <Space.Compact style={{ width: '100%' }}>
                  <Input aria-label={`${t.name} observation`} placeholder="Observation" value={d?.value ?? ''} onChange={(e) => set(t.id, { value: e.target.value })} />
                  <Select
                    aria-label={`${t.name} complies`}
                    placeholder="Complies?"
                    style={{ width: 120 }}
                    value={d?.complies === undefined ? undefined : d.complies ? 'yes' : 'no'}
                    onChange={(v: string) => set(t.id, { complies: v === 'yes' })}
                    options={[{ value: 'yes', label: 'Complies' }, { value: 'no', label: 'Does not' }]}
                  />
                </Space.Compact>
              );
            },
          },
          {
            title: 'Pass',
            width: 80,
            render: (_, t) => {
              const r = byTest.get(t.id);
              return r ? <Tag color={r.passed ? 'green' : 'red'}>{r.passed ? 'PASS' : 'FAIL'}</Tag> : null;
            },
          },
          {
            title: 'Remarks',
            render: (_, t) => {
              const r = byTest.get(t.id);
              if (r) return r.remarks ?? '';
              return canEnter ? <Input aria-label={`${t.name} remarks`} value={drafts[t.id]?.remarks ?? ''} onChange={(e) => set(t.id, { remarks: e.target.value })} /> : null;
            },
          },
          {
            title: 'Entered / reviewed',
            render: (_, t) => {
              const r = byTest.get(t.id);
              if (!r) return null;
              return (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {name(r.enteredBy)} · {formatDateTime(r.enteredAt)}
                  <br />
                  {r.reviewedBy ? `Reviewed: ${name(r.reviewedBy)}` : 'Not reviewed'}
                </Typography.Text>
              );
            },
          },
        ]}
      />
      {canEnter && (s.tests ?? []).some((t) => !byTest.has(t.id)) && (
        <Button type="primary" style={{ marginTop: 8 }} loading={busy} onClick={() => void save()}>
          Save results
        </Button>
      )}
      {superseded.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong>Superseded results (kept unchanged; a later re-test is the latest)</Typography.Text>
          <Table<ResultDto>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={superseded}
            columns={[
              { title: 'Test', render: (_, r) => testName(r.specTestId) },
              { title: 'Result', render: (_, r) => resultText(r) },
              { title: 'Pass', render: (_, r) => <Tag color={r.passed ? 'green' : 'red'}>{r.passed ? 'PASS' : 'FAIL'}</Tag> },
              { title: 'Entered', render: (_, r) => `${name(r.enteredBy)} · ${formatDateTime(r.enteredAt)}` },
              { title: 'Reviewed', render: (_, r) => (r.reviewedBy ? name(r.reviewedBy) : 'Not reviewed') },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Re-test reasons: {(s.results ?? []).filter((r) => r.retestOf).map((r) => `${testName(r.specTestId)}: ${r.retestReason}`).join('; ')}
          </Typography.Text>
        </div>
      )}
      {retesting && <RetestModal sampleId={s.id} test={retesting.test} result={retesting.result} onClose={() => setRetesting(null)} onDone={onDone} />}
    </div>
  );
}

/** Re-test (0039): a new result for the test, repeating its latest result; the original is never edited. */
function RetestModal({ sampleId, test, result, onClose, onDone }: { sampleId: string; test: SpecTestDto; result: ResultDto; onClose(): void; onDone(): Promise<void> }) {
  const { message } = App.useApp();
  const [value, setValue] = useState('');
  const [complies, setComplies] = useState<boolean | undefined>(undefined);
  const [remarks, setRemarks] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body =
      test.resultType === 'NUMERIC'
        ? { numericValue: value.trim(), remarks: remarks.trim() || null, reason }
        : { textValue: value.trim(), complies: complies ?? null, remarks: remarks.trim() || null, reason };
    const parsed = RetestResultRequest.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/qc/samples/${sampleId}/results/${result.id}/retest`, { method: 'POST', body: parsed.data });
      void message.success('Re-test saved');
      onClose();
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`Re-test: ${test.name}`} okText="Save re-test" confirmLoading={busy} onOk={() => void submit()} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          The current result stays on record unchanged; the re-test becomes the latest result and is reviewed like any other. Limit: {limitText(test)}.
        </Typography.Text>
        {error && <Alert type="error" showIcon message={error} />}
        {test.resultType === 'NUMERIC' ? (
          <Input aria-label="Re-test result" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} suffix={test.unit ?? undefined} />
        ) : (
          <Space.Compact style={{ width: '100%' }}>
            <Input aria-label="Re-test observation" placeholder="Observation" value={value} onChange={(e) => setValue(e.target.value)} />
            <Select
              aria-label="Re-test complies"
              placeholder="Complies?"
              style={{ width: 120 }}
              value={complies === undefined ? undefined : complies ? 'yes' : 'no'}
              onChange={(v: string) => setComplies(v === 'yes')}
              options={[{ value: 'yes', label: 'Complies' }, { value: 'no', label: 'Does not' }]}
            />
          </Space.Compact>
        )}
        <Input aria-label="Re-test remarks" placeholder="Remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        <Input.TextArea aria-label="Re-test reason" rows={3} maxLength={500} placeholder="Why the test is repeated (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Space>
    </Modal>
  );
}
