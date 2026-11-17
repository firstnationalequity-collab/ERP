// Approval matrix (core.settings.manage; architecture §3, decision Q12).
// Band = above "lower" (exclusive) up to and including "upper". Same step number = "and" (parallel);
// higher step number = "then" (after). Changes apply to new approvals only.
import { useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Tag, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApprovalMeasure, GmpLockedApprovals, type ApprovalRuleSetDto, type RoleDto, type WitnessSignRequest } from '@albert/shared';
import { api, errorText } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { ESignModal } from '../../components/ESignModal';
import { formatDecimal } from '../../lib/format';

type Band = ApprovalRuleSetDto['bands'][number];

function bound(v: string | null, measure: ApprovalMeasure): string {
  if (v === null) return '';
  return measure === 'PERCENT' ? `${formatDecimal(v, 2)}%` : formatDecimal(v, 2);
}

/** "PKR 500,000.01 to 5,000,000.00" style label for a band. */
export function bandLabel(b: Pick<Band, 'lowerBound' | 'upperBound'>, measure: ApprovalMeasure): string {
  if (measure === 'NONE') return 'Every document';
  const unit = measure === 'AMOUNT_PKR' ? 'PKR ' : '';
  if (b.lowerBound === null && b.upperBound === null) return 'Any value';
  if (b.lowerBound === null) return `Up to ${unit}${bound(b.upperBound, measure)}`;
  if (b.upperBound === null) return `Above ${unit}${bound(b.lowerBound, measure)}`;
  return `Above ${unit}${bound(b.lowerBound, measure)} up to ${bound(b.upperBound, measure)}`;
}

function stepsLabel(b: Band): string {
  const byStep = new Map<number, string[]>();
  for (const s of b.steps) byStep.set(s.stepNo, [...(byStep.get(s.stepNo) ?? []), s.roleName]);
  return [...byStep.entries()]
    .sort(([a], [c]) => a - c)
    .map(([, names]) => names.join(' and '))
    .join(', then ');
}

export function ApprovalRulesPage() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['approval-rules'], queryFn: () => api<ApprovalRuleSetDto[]>('/core/approval-rules') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/core/roles') });
  const [editing, setEditing] = useState<ApprovalRuleSetDto | null>(null);

  return (
    <>
      <PageHeader title="Approval rules">
        Who approves which document. Limits are placeholders until Finance confirms them. Changes apply to new approvals only.
      </PageHeader>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="The person who created a document never approves it, and one person approves at most one step of the same approval."
      />
      <Row gutter={[16, 16]}>
        {(rules.data ?? []).map((set) => (
          <Col xs={24} lg={12} key={set.docType}>
            <Card title={set.docType} extra={<Button type="link" onClick={() => setEditing(set)}>Edit</Button>} size="small">
              {set.lockedToKey && (
                <Tag color="gold" style={{ marginBottom: 8 }}>GMP-locked: approvers must hold {set.lockedToKey}</Tag>
              )}
              <Typography.Paragraph type="secondary">Measured on: {set.measure === 'AMOUNT_PKR' ? 'amount in PKR' : set.measure === 'PERCENT' ? 'percent' : 'no value'}</Typography.Paragraph>
              {set.bands.map((b) => (
                <div key={`${b.lowerBound}-${b.upperBound}`} style={{ marginBottom: 8 }}>
                  <Tag>{bandLabel(b, set.measure)}</Tag> {stepsLabel(b)}
                </div>
              ))}
            </Card>
          </Col>
        ))}
        {rules.data?.length === 0 && <Empty description="No approval rules" />}
      </Row>
      {editing && (
        <RulesModal
          set={editing}
          roles={(roles.data ?? []).filter((r) => r.isActive)}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['approval-rules'] })}
        />
      )}
    </>
  );
}

interface FormBand {
  lowerBound?: string;
  upperBound?: string;
  steps: { stepNo: number; roleId: string }[];
}

function RulesModal({ set, roles, onClose, onSaved }: { set: ApprovalRuleSetDto; roles: RoleDto[]; onClose(): void; onSaved(): unknown }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ measure: ApprovalMeasure; bands: FormBand[]; reason: string }>();
  const measure = Form.useWatch('measure', form) ?? set.measure;
  const [error, setError] = useState<string | null>(null);
  const lockedKey = GmpLockedApprovals[set.docType];
  const [askCountersign, setAskCountersign] = useState(false);

  const save = async (countersign?: WitnessSignRequest) => {
    const v = await form.validateFields();
    try {
      await api(`/core/approval-rules/${set.docType}`, {
        method: 'PUT',
        body: {
          measure: v.measure,
          reason: v.reason,
          bands: v.bands.map((b) => ({
            lowerBound: v.measure === 'NONE' || !b.lowerBound ? null : b.lowerBound,
            upperBound: v.measure === 'NONE' || !b.upperBound ? null : b.upperBound,
            steps: b.steps,
          })),
          ...(countersign ? { countersign } : {}),
        },
      });
      void message.success('Approval rules saved');
      await onSaved();
      onClose();
    } catch (err) {
      if (countersign) throw err; // shown inside the countersign dialog
      setError(errorText(err));
    }
  };

  const onOk = async () => {
    await form.validateFields();
    if (lockedKey) await save();
    else setAskCountersign(true);
  };

  const decimalRule = { pattern: /^\d{1,14}(\.\d{1,4})?$/, message: 'A number, e.g. 500000 or 5.5' };
  return (
    <Modal open width={760} title={`Approval rules: ${set.docType}`} onCancel={onClose} onOk={() => void onOk()} okText={lockedKey ? 'Save' : 'Next'}>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {lockedKey ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`GMP-locked: every approver role must hold ${lockedKey}. This cannot be changed here.`} />
      ) : (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Saving needs a Finance Manager countersign (a different person from you)." />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          measure: set.measure,
          bands: set.bands.map((b) => ({ lowerBound: b.lowerBound ?? undefined, upperBound: b.upperBound ?? undefined, steps: b.steps.map((s) => ({ stepNo: s.stepNo, roleId: s.roleId })) })),
        }}
      >
        <Form.Item name="measure" label="Measured on">
          <Select options={[{ value: 'AMOUNT_PKR', label: 'Amount in PKR' }, { value: 'PERCENT', label: 'Percent' }, { value: 'NONE', label: 'No value (one band)' }]} />
        </Form.Item>
        <Form.List name="bands">
          {(bands, { add, remove }) => (
            <>
              {bands.map((band) => (
                <Card key={band.key} size="small" style={{ marginBottom: 12 }} extra={<MinusCircleOutlined onClick={() => remove(band.name)} />} title="Band">
                  {measure !== 'NONE' && (
                    <Space wrap>
                      <Form.Item name={[band.name, 'lowerBound']} label="Above (leave empty for no lower limit)" rules={[decimalRule]}><Input style={{ width: 200 }} /></Form.Item>
                      <Form.Item name={[band.name, 'upperBound']} label="Up to and including (empty = no limit)" rules={[decimalRule]}><Input style={{ width: 200 }} /></Form.Item>
                    </Space>
                  )}
                  <Form.List name={[band.name, 'steps']}>
                    {(steps, s) => (
                      <>
                        {steps.map((step) => (
                          <Space key={step.key} align="baseline" wrap>
                            <Form.Item name={[step.name, 'stepNo']} label="Step" rules={[{ required: true }]}><InputNumber min={1} max={9} /></Form.Item>
                            <Form.Item name={[step.name, 'roleId']} label="Role" rules={[{ required: true }]}>
                              <Select style={{ width: 260 }} showSearch optionFilterProp="label" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => s.remove(step.name)} />
                          </Space>
                        ))}
                        <Button type="dashed" icon={<PlusOutlined />} onClick={() => s.add({ stepNo: steps.length + 1 })}>Add step</Button>
                      </>
                    )}
                  </Form.List>
                </Card>
              ))}
              {(measure !== 'NONE' || bands.length === 0) && (
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ steps: [{ stepNo: 1 }] })} style={{ marginBottom: 12 }}>Add band</Button>
              )}
            </>
          )}
        </Form.List>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Same step number = both must approve (any order). Step 2 opens only after step 1 is complete.
        </Typography.Paragraph>
        <Form.Item name="reason" label="Reason for the change" rules={[{ required: true, min: 3 }]}><Input /></Form.Item>
      </Form>
      <ESignModal
        open={askCountersign}
        title={`Finance Manager countersign: ${set.docType}`}
        meaning="APPROVED"
        ownSignature={false}
        countersign="required"
        countersignBy="Finance Manager"
        countersignNote="Approval limits are Finance's decision. A Finance Manager confirms this change with their own password."
        summary="The countersign is stored as an e-signature on the rule set."
        okText="Save rules"
        onCancel={() => setAskCountersign(false)}
        onSubmit={(r) => save(r.countersign)}
      />
    </Modal>
  );
}
