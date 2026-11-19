// One form component for every master/document dialog (architecture §8): React Hook Form validated with the SAME
// Zod schema the API uses (packages/shared), API field errors shown on the fields, and — for records whose
// sensitive fields need it — a countersign step when the API answers COUNTERSIGN_REQUIRED (the API decides; the
// form only asks the second person to sign and sends the same values again).
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Checkbox, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Select, Switch } from 'antd';
import { Controller, useForm, type FieldValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import dayjs from 'dayjs';
import type { z } from 'zod';
import type { WitnessSignRequest } from '@albert/shared';
import { ApiRequestError, errorText } from '../api/client';
import { apiFieldErrors, changedKeys, prepareValues, type FormMode } from '../lib/formValues';
import { ESignModal } from './ESignModal';
import { RefSelect } from './RefSelect';

interface BaseField {
  name: string;
  label: string;
  help?: ReactNode;
  disabled?: boolean;
  /** On edit forms, an emptied field is sent as null (clears it); otherwise empty = not sent. */
  nullable?: boolean;
  placeholder?: string;
}
export type FieldDef =
  | (BaseField & { kind: 'text' | 'textarea' | 'decimal' })
  | (BaseField & { kind: 'select'; options: { value: string; label: string }[] })
  /** A master record picked by search (e.g. items) from a list endpoint. */
  | (BaseField & { kind: 'ref'; path: string; params?: Record<string, string> })
  | (BaseField & { kind: 'int' })
  | (BaseField & { kind: 'date' })
  | (BaseField & { kind: 'switch' | 'checkbox' });


interface Props<S extends z.ZodTypeAny> {
  open: boolean;
  title: string;
  mode: FormMode;
  schema: S;
  fields: FieldDef[];
  initialValues?: Record<string, unknown>;
  /** Fixed facts shown above the form (e.g. code and type, which never change). */
  readOnly?: { label: string; value: ReactNode }[];
  intro?: ReactNode;
  /** Who countersigns when the API asks for it, e.g. "QA Manager". Without it a COUNTERSIGN_REQUIRED is just shown. */
  countersignBy?: string;
  okText?: string;
  width?: number;
  onCancel(): void;
  /** Throw to keep the dialog open; the error is shown. */
  onSubmit(values: z.infer<S>, countersign?: WitnessSignRequest): Promise<unknown>;
}

export function DocForm<S extends z.ZodTypeAny>(props: Props<S>) {
  const { open, title, mode, schema, fields, initialValues = {}, readOnly, intro, countersignBy, okText, width, onCancel, onSubmit } = props;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ values: z.infer<S>; message: string } | null>(null);
  const initialPrepared = prepareValues(initialValues, fields, mode);

  const resolver: Resolver<FieldValues> = (values, ctx, opts) =>
    zodResolver(schema)(prepareValues(values, fields, mode), ctx, opts) as ReturnType<Resolver<FieldValues>>;
  const form = useForm<FieldValues>({ resolver, defaultValues: initialValues, mode: 'onSubmit' });

  useEffect(() => {
    if (open) {
      form.reset(initialValues);
      setError(null);
      setPending(null);
    }
  }, [open]); // reset only when the dialog opens

  const send = async (values: z.infer<S>, countersign?: WitnessSignRequest) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values, countersign);
      setPending(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'COUNTERSIGN_REQUIRED' && countersignBy && !countersign) {
        setPending({ values, message: err.message });
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'VALIDATION_FAILED') {
        for (const [name, msg] of Object.entries(apiFieldErrors(err.details, fields.map((f) => f.name)))) form.setError(name, { message: msg });
      }
      if (pending) throw err; // shown inside the countersign dialog
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = form.handleSubmit(async (parsed) => {
    let values = parsed as Record<string, unknown>;
    if (mode === 'edit') {
      const changed = changedKeys(values, initialPrepared);
      if (changed.length === 0) {
        setError('Nothing was changed');
        return;
      }
      values = Object.fromEntries(changed.filter((k) => k in values).map((k) => [k, values[k]]));
    }
    await send(values as z.infer<S>);
  });

  return (
    <>
      <Modal open={open && !pending} title={title} onOk={() => void submit()} onCancel={onCancel} confirmLoading={busy} okText={okText ?? 'Save'} width={width} destroyOnClose maskClosable={false}>
        {intro}
        {readOnly && readOnly.length > 0 && (
          <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }} items={readOnly.map((r, i) => ({ key: String(i), label: r.label, children: r.value }))} />
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Form layout="vertical" requiredMark={false} autoComplete="off" onFinish={() => void submit()}>
          {fields.map((f) => (
            <Controller
              key={f.name}
              name={f.name}
              control={form.control}
              render={({ field, fieldState }) => (
                <Form.Item label={f.label} help={fieldState.error?.message ?? f.help} validateStatus={fieldState.error ? 'error' : undefined}>
                  {renderInput(f, field.value, field.onChange, field.onBlur)}
                </Form.Item>
              )}
            />
          ))}
        </Form>
      </Modal>
      <ESignModal
        open={pending !== null}
        title={`${title}: countersign`}
        meaning="APPROVED"
        ownSignature={false}
        askReason={false}
        countersign="required"
        countersignBy={countersignBy ?? 'QA Manager'}
        countersignNote={pending?.message}
        okText="Countersign and save"
        onCancel={() => setPending(null)}
        onSubmit={async (r) => {
          if (pending && r.countersign) await send(pending.values, r.countersign);
        }}
      />
    </>
  );
}

function renderInput(f: FieldDef, value: unknown, onChange: (v: unknown) => void, onBlur: () => void): ReactNode {
  const common = { disabled: f.disabled, placeholder: f.placeholder, onBlur, 'aria-label': f.label };
  switch (f.kind) {
    case 'text':
    case 'decimal':
      return <Input {...common} inputMode={f.kind === 'decimal' ? 'decimal' : undefined} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'textarea':
      return <Input.TextArea {...common} rows={3} value={(value as string | undefined) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      return <Select {...common} allowClear showSearch optionFilterProp="label" value={(value as string | undefined) ?? undefined} onChange={(v) => onChange(v ?? '')} options={f.options} />;
    case 'ref':
      return <RefSelect {...common} path={f.path} params={f.params} value={(value as string | undefined) || undefined} onChange={(v) => onChange(v ?? '')} />;
    case 'int':
      return <InputNumber {...common} precision={0} min={0} style={{ width: '100%' }} value={(value as number | null | undefined) ?? null} onChange={(v) => onChange(v ?? null)} />;
    case 'date':
      return (
        <DatePicker
          {...common}
          format="DD-MM-YYYY"
          style={{ width: '100%' }}
          value={typeof value === 'string' && value ? dayjs(value) : null}
          onChange={(d) => onChange(d ? d.format('YYYY-MM-DD') : '')}
        />
      );
    case 'switch':
      return <Switch disabled={f.disabled} aria-label={f.label} checked={value === true} onChange={(v) => onChange(v)} />;
    case 'checkbox':
      return <Checkbox disabled={f.disabled} aria-label={f.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
}
