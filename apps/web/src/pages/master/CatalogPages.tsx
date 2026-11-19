// Simple masters: tax codes, units of measure, item categories, UoM conversions, warehouses, locations.
import {
  CreateCategoryRequest,
  CreateConversionRequest,
  CreateLocationRequest,
  CreateTaxCodeRequest,
  CreateUomRequest,
  CreateWarehouseRequest,
  StorageZone,
  TaxKind,
  UpdateLocationRequest,
  UpdateNameRequest,
  UpdateTaxCodeRequest,
  UpdateWarehouseRequest,
  type CategoryDto,
  type ConversionDto,
  type LocationDto,
  type TaxCodeDto,
  type UomDto,
  type WarehouseDto,
} from '@albert/shared';
import { Tag } from 'antd';
import { ACTIVE_FILTER } from '../../components/DataTable';
import { RefLabel } from '../../components/RefSelect';
import { StatusTag } from '../../components/StatusTag';
import { formatDecimal } from '../../lib/format';
import { MasterPage, enumOptions, yesNo } from './MasterPage';

const activeCol = <T extends { isActive: boolean }>() => ({
  key: 'isActive',
  title: 'Status',
  render: (r: T) => <StatusTag status={r.isActive ? 'ACTIVE' : 'INACTIVE'} />,
  exportValue: (r: T) => (r.isActive ? 'ACTIVE' : 'INACTIVE'),
});
const isActive = (r: { isActive: boolean }) => r.isActive;

export function TaxCodesPage() {
  return (
    <MasterPage<TaxCodeDto, typeof CreateTaxCodeRequest, typeof UpdateTaxCodeRequest>
      config={{
        title: 'Tax codes',
        intro: 'Sales tax and withholding tax rates. A rate marked "not confirmed" cannot be posted until Finance confirms it.',
        path: '/master/tax-codes',
        noun: 'tax code',
        manageKey: 'fin.master.manage',
        filters: [ACTIVE_FILTER],
        columns: [
          { key: 'code', title: 'Code' },
          { key: 'name', title: 'Name' },
          { key: 'kind', title: 'Kind', render: (r) => r.kind.replace(/_/g, ' ') },
          { key: 'rate', title: 'Rate %', render: (r) => formatDecimal(r.rate, 4), exportValue: (r) => r.rate },
          { key: 'isPlaceholder', title: 'Confirmed', render: (r) => (r.isPlaceholder ? <Tag color="orange">NOT CONFIRMED</Tag> : 'Yes'), exportValue: (r) => yesNo(!r.isPlaceholder) },
          activeCol<TaxCodeDto>(),
        ],
        isActive,
        create: {
          schema: CreateTaxCodeRequest,
          initial: { isPlaceholder: false },
          fields: [
            { name: 'code', label: 'Code', kind: 'text' },
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'kind', label: 'Kind', kind: 'select', options: enumOptions(TaxKind) },
            { name: 'rate', label: 'Rate % (0–100, up to 4 decimals)', kind: 'decimal' },
            { name: 'isPlaceholder', label: 'Rate not confirmed yet', kind: 'switch' },
          ],
        },
        edit: {
          schema: UpdateTaxCodeRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }, { label: 'Kind', value: r.kind }],
          initial: (r) => ({ name: r.name, rate: r.rate, isPlaceholder: r.isPlaceholder }),
          fields: (r) => [
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'rate', label: 'Rate %', kind: 'decimal' },
            {
              name: 'isPlaceholder',
              label: 'Rate not confirmed yet (switch off to confirm)',
              kind: 'switch',
              disabled: !r.isPlaceholder,
              help: r.isPlaceholder ? undefined : 'A confirmed tax code cannot be marked unconfirmed again',
            },
          ],
        },
      }}
    />
  );
}

export function UomsPage() {
  return (
    <MasterPage<UomDto, typeof CreateUomRequest, typeof UpdateNameRequest>
      config={{
        title: 'Units of measure',
        path: '/master/uoms',
        noun: 'unit of measure',
        manageKey: 'master.item.manage',
        filters: [ACTIVE_FILTER],
        columns: [{ key: 'code', title: 'Code' }, { key: 'name', title: 'Name' }, activeCol<UomDto>()],
        isActive,
        create: { schema: CreateUomRequest, fields: [{ name: 'code', label: 'Code', kind: 'text' }, { name: 'name', label: 'Name', kind: 'text' }] },
        edit: {
          schema: UpdateNameRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }],
          initial: (r) => ({ name: r.name }),
          fields: () => [{ name: 'name', label: 'Name', kind: 'text' }],
        },
      }}
    />
  );
}

export function CategoriesPage() {
  return (
    <MasterPage<CategoryDto, typeof CreateCategoryRequest, typeof UpdateNameRequest>
      config={{
        title: 'Item categories',
        intro: 'Posting rules can name a category, so each category can post to its own inventory account.',
        path: '/master/item-categories',
        noun: 'item category',
        manageKey: 'master.item.manage',
        filters: [ACTIVE_FILTER],
        columns: [{ key: 'code', title: 'Code' }, { key: 'name', title: 'Name' }, activeCol<CategoryDto>()],
        isActive,
        create: { schema: CreateCategoryRequest, fields: [{ name: 'code', label: 'Code', kind: 'text' }, { name: 'name', label: 'Name', kind: 'text' }] },
        edit: {
          schema: UpdateNameRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }],
          initial: (r) => ({ name: r.name }),
          fields: () => [{ name: 'name', label: 'Name', kind: 'text' }],
        },
      }}
    />
  );
}

export function ConversionsPage() {
  return (
    <MasterPage<ConversionDto, typeof CreateConversionRequest, typeof CreateConversionRequest>
      config={{
        title: 'UoM conversions',
        intro: '1 from-unit = factor × to-unit. A conversion is never edited: deactivate it and add a new one.',
        path: '/master/uom-conversions',
        noun: 'conversion',
        manageKey: 'master.item.manage',
        filters: [ACTIVE_FILTER],
        searchPlaceholder: 'Search is not available here; use the filters',
        columns: [
          { key: 'itemId', title: 'Item', render: (r) => (r.itemId ? <RefLabel path="/master/items" id={r.itemId} /> : 'All items') },
          { key: 'fromUomId', title: 'From', render: (r) => <RefLabel path="/master/uoms" id={r.fromUomId} /> },
          { key: 'factor', title: 'Factor', render: (r) => formatDecimal(r.factor, 6), exportValue: (r) => r.factor },
          { key: 'toUomId', title: 'To', render: (r) => <RefLabel path="/master/uoms" id={r.toUomId} /> },
          activeCol<ConversionDto>(),
        ],
        isActive,
        create: {
          schema: CreateConversionRequest,
          fields: [
            { name: 'itemId', label: 'Item (empty = every item)', kind: 'ref', path: '/master/items' },
            { name: 'fromUomId', label: 'From unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
            { name: 'toUomId', label: 'To unit', kind: 'ref', path: '/master/uoms', params: { active: 'active' } },
            { name: 'factor', label: 'Factor (up to 6 decimals)', kind: 'decimal' },
          ],
        },
      }}
    />
  );
}

export function WarehousesPage() {
  return (
    <MasterPage<WarehouseDto, typeof CreateWarehouseRequest, typeof UpdateWarehouseRequest>
      config={{
        title: 'Warehouses',
        path: '/master/warehouses',
        noun: 'warehouse',
        manageKey: 'master.location.manage',
        filters: [ACTIVE_FILTER],
        columns: [{ key: 'code', title: 'Code' }, { key: 'name', title: 'Name' }, { key: 'address', title: 'Address' }, activeCol<WarehouseDto>()],
        isActive,
        create: {
          schema: CreateWarehouseRequest,
          fields: [
            { name: 'code', label: 'Code', kind: 'text' },
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'address', label: 'Address', kind: 'textarea' },
          ],
        },
        edit: {
          schema: UpdateWarehouseRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }],
          initial: (r) => ({ name: r.name, address: r.address ?? '' }),
          fields: () => [
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'address', label: 'Address', kind: 'textarea', nullable: true },
          ],
        },
      }}
    />
  );
}

export function LocationsPage() {
  return (
    <MasterPage<LocationDto, typeof CreateLocationRequest, typeof UpdateLocationRequest>
      config={{
        title: 'Locations',
        intro: 'Racks and bays inside a warehouse. Customer returns are received only into a location marked "returns area".',
        path: '/master/locations',
        noun: 'location',
        manageKey: 'master.location.manage',
        filters: [ACTIVE_FILTER],
        columns: [
          { key: 'warehouseId', title: 'Warehouse', render: (r) => <RefLabel path="/master/warehouses" id={r.warehouseId} /> },
          { key: 'code', title: 'Code' },
          { key: 'name', title: 'Name' },
          { key: 'storageZone', title: 'Storage', render: (r) => r.storageZone.replace(/_/g, ' ') },
          { key: 'isReturnsArea', title: 'Returns area', render: (r) => (r.isReturnsArea ? <Tag color="purple">RETURNS</Tag> : ''), exportValue: (r) => yesNo(r.isReturnsArea) },
          activeCol<LocationDto>(),
        ],
        isActive,
        create: {
          schema: CreateLocationRequest,
          initial: { storageZone: 'AMBIENT', isReturnsArea: false },
          fields: [
            { name: 'warehouseId', label: 'Warehouse', kind: 'ref', path: '/master/warehouses', params: { active: 'active' } },
            { name: 'code', label: 'Code', kind: 'text' },
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'storageZone', label: 'Storage condition', kind: 'select', options: enumOptions(StorageZone) },
            { name: 'isReturnsArea', label: 'Returns area (customer returns are received here)', kind: 'switch' },
          ],
        },
        edit: {
          schema: UpdateLocationRequest,
          readOnly: (r) => [{ label: 'Code', value: r.code }, { label: 'Warehouse', value: <RefLabel path="/master/warehouses" id={r.warehouseId} /> }],
          initial: (r) => ({ name: r.name, storageZone: r.storageZone, isReturnsArea: r.isReturnsArea }),
          fields: () => [
            { name: 'name', label: 'Name', kind: 'text' },
            { name: 'storageZone', label: 'Storage condition', kind: 'select', options: enumOptions(StorageZone) },
            { name: 'isReturnsArea', label: 'Returns area (customer returns are received here)', kind: 'switch' },
          ],
        },
      }}
    />
  );
}
