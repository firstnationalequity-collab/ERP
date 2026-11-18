// /api/v1/master/* — mounted behind authenticate + requireCurrentPassword (app.ts).
// Reads need master.view; each write declares its key. Status-like changes are action endpoints
// (POST /:id/activate | /deactivate | /submit | /block), never PATCH (CLAUDE.md conventions).
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  BlockSourceRequest,
  CreateAddressRequest,
  CreateApprovedSourceRequest,
  CreateCategoryRequest,
  CreateConversionRequest,
  CreateCustomerRequest,
  CreateFormulaRequest,
  CreateItemRequest,
  CreateLocationRequest,
  CreatePriceListLineRequest,
  CreatePriceListRequest,
  CreateProductRequest,
  CreateTaxCodeRequest,
  CreateUomRequest,
  CreateVendorRequest,
  CreateWarehouseRequest,
  DeactivateRequest,
  MasterActionRequest,
  MasterListQuery,
  SetFormulaLinesRequest,
  UpdateAddressRequest,
  UpdateCustomerRequest,
  UpdateFormulaRequest,
  UpdateItemRequest,
  UpdateLocationRequest,
  UpdateNameRequest,
  UpdatePriceListLineRequest,
  UpdatePriceListRequest,
  UpdateProductRequest,
  UpdateTaxCodeRequest,
  UpdateVendorRequest,
  UpdateWarehouseRequest,
  type PermissionKey,
} from '@albert/shared';
import { requireAnyPermission, requirePermission } from '../../core/rbac/require-permission';
import { asyncHandler, authOf, requestMeta } from '../../core/auth/middleware';
import * as catalog from './catalog.service';
import * as itemsSvc from './items.service';
import * as parties from './parties.service';
import * as avl from './avl.service';
import * as productsSvc from './products.service';
import * as formulas from './formulas.service';

const IdParam = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') });
const idOf = (req: Request) => IdParam.parse(req.params).id;
const listQuery = (req: Request) => MasterListQuery.parse(req.query);
const VIEW: PermissionKey = 'master.view';

export const mastersRouter = Router();
const r = mastersRouter;

/** POST /<resource>/:id/activate | /deactivate for masters with an is_active flag. */
function activeFlagRoutes(resource: catalog.ActiveFlagResource, key: PermissionKey): void {
  r.post(
    `/${resource}/:id/activate`,
    requirePermission(key),
    asyncHandler(async (req, res) => {
      const { reason } = MasterActionRequest.parse(req.body ?? {});
      await catalog.setMasterActive(authOf(req), resource, idOf(req), true, reason);
      res.status(204).end();
    }),
  );
  r.post(
    `/${resource}/:id/deactivate`,
    requirePermission(key),
    asyncHandler(async (req, res) => {
      const { reason } = DeactivateRequest.parse(req.body ?? {});
      await catalog.setMasterActive(authOf(req), resource, idOf(req), false, reason);
      res.status(204).end();
    }),
  );
}

// ---------------------------------------------------------------- tax codes (fin.master.manage)

r.get('/tax-codes', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listTaxCodes(authOf(req), listQuery(req))); }));
r.get('/tax-codes/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getTaxCode(authOf(req), idOf(req))); }));
r.post('/tax-codes', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createTaxCode(authOf(req), CreateTaxCodeRequest.parse(req.body)));
}));
r.patch('/tax-codes/:id', requirePermission('fin.master.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updateTaxCode(authOf(req), idOf(req), UpdateTaxCodeRequest.parse(req.body)));
}));
activeFlagRoutes('tax-codes', 'fin.master.manage');

// ---------------------------------------------------------------- UoM, categories, items, conversions (master.item.manage)

r.get('/uoms', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listUoms(authOf(req), listQuery(req))); }));
r.get('/uoms/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getUom(authOf(req), idOf(req))); }));
r.post('/uoms', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createUom(authOf(req), CreateUomRequest.parse(req.body)));
}));
r.patch('/uoms/:id', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updateUom(authOf(req), idOf(req), UpdateNameRequest.parse(req.body)));
}));
activeFlagRoutes('uoms', 'master.item.manage');

r.get('/item-categories', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listCategories(authOf(req), listQuery(req))); }));
r.get('/item-categories/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getCategory(authOf(req), idOf(req))); }));
r.post('/item-categories', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createCategory(authOf(req), CreateCategoryRequest.parse(req.body)));
}));
r.patch('/item-categories/:id', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updateCategory(authOf(req), idOf(req), UpdateNameRequest.parse(req.body)));
}));
activeFlagRoutes('item-categories', 'master.item.manage');

// Items: DRAFT → ACTIVE ⇄ INACTIVE. GMP items move with master.item.approve (QA), others with master.item.manage;
// the route admits either key and core/transition checks the one the item's type needs.
r.get('/items', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await itemsSvc.listItems(authOf(req), listQuery(req))); }));
r.get('/items/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await itemsSvc.getItem(authOf(req), idOf(req))); }));
r.post('/items', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await itemsSvc.createItem(authOf(req), CreateItemRequest.parse(req.body)));
}));
r.patch('/items/:id', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.json(await itemsSvc.updateItem(authOf(req), idOf(req), UpdateItemRequest.parse(req.body), requestMeta(req)));
}));
r.post('/items/:id/activate', requireAnyPermission('master.item.approve', 'master.item.manage'), asyncHandler(async (req, res) => {
  const { reason } = MasterActionRequest.parse(req.body ?? {});
  res.json(await itemsSvc.changeItemStatus(authOf(req), idOf(req), 'ACTIVE', reason));
}));
r.post('/items/:id/deactivate', requireAnyPermission('master.item.approve', 'master.item.manage'), asyncHandler(async (req, res) => {
  const { reason } = DeactivateRequest.parse(req.body ?? {});
  res.json(await itemsSvc.changeItemStatus(authOf(req), idOf(req), 'INACTIVE', reason));
}));

r.get('/uom-conversions', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listConversions(authOf(req), listQuery(req))); }));
r.get('/uom-conversions/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getConversion(authOf(req), idOf(req))); }));
r.post('/uom-conversions', requirePermission('master.item.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createConversion(authOf(req), CreateConversionRequest.parse(req.body)));
}));
activeFlagRoutes('uom-conversions', 'master.item.manage');

// ---------------------------------------------------------------- warehouses and locations (master.location.manage)

r.get('/warehouses', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listWarehouses(authOf(req), listQuery(req))); }));
r.get('/warehouses/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getWarehouse(authOf(req), idOf(req))); }));
r.post('/warehouses', requirePermission('master.location.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createWarehouse(authOf(req), CreateWarehouseRequest.parse(req.body)));
}));
r.patch('/warehouses/:id', requirePermission('master.location.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updateWarehouse(authOf(req), idOf(req), UpdateWarehouseRequest.parse(req.body)));
}));
activeFlagRoutes('warehouses', 'master.location.manage');

r.get('/locations', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listLocations(authOf(req), listQuery(req))); }));
r.get('/locations/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getLocation(authOf(req), idOf(req))); }));
r.post('/locations', requirePermission('master.location.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createLocation(authOf(req), CreateLocationRequest.parse(req.body)));
}));
r.patch('/locations/:id', requirePermission('master.location.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updateLocation(authOf(req), idOf(req), UpdateLocationRequest.parse(req.body)));
}));
activeFlagRoutes('locations', 'master.location.manage');

// ---------------------------------------------------------------- customers and addresses

r.get('/customers', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await parties.listCustomers(authOf(req), listQuery(req))); }));
r.get('/customers/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await parties.getCustomer(authOf(req), idOf(req))); }));
r.post('/customers', requirePermission('master.customer.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await parties.createCustomer(authOf(req), CreateCustomerRequest.parse(req.body)));
}));
r.patch('/customers/:id', requirePermission('master.customer.manage'), asyncHandler(async (req, res) => {
  res.json(await parties.updateCustomer(authOf(req), idOf(req), UpdateCustomerRequest.parse(req.body), requestMeta(req)));
}));
r.post('/customers/:id/activate', requirePermission('master.customer.approve'), asyncHandler(async (req, res) => {
  const { reason } = MasterActionRequest.parse(req.body ?? {});
  await parties.changePartyStatus(authOf(req), 'customer', idOf(req), 'ACTIVE', reason);
  res.json(await parties.getCustomer(authOf(req), idOf(req)));
}));
r.post('/customers/:id/deactivate', requirePermission('master.customer.approve'), asyncHandler(async (req, res) => {
  const { reason } = DeactivateRequest.parse(req.body ?? {});
  await parties.changePartyStatus(authOf(req), 'customer', idOf(req), 'INACTIVE', reason);
  res.json(await parties.getCustomer(authOf(req), idOf(req)));
}));
r.get('/customers/:id/addresses', requirePermission(VIEW), asyncHandler(async (req, res) => {
  res.json(await parties.listAddresses(authOf(req), idOf(req)));
}));
r.post('/customers/:id/addresses', requirePermission('master.customer.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await parties.createAddress(authOf(req), idOf(req), CreateAddressRequest.parse(req.body)));
}));
r.patch('/customer-addresses/:id', requirePermission('master.customer.manage'), asyncHandler(async (req, res) => {
  res.json(await parties.updateAddress(authOf(req), idOf(req), UpdateAddressRequest.parse(req.body)));
}));
activeFlagRoutes('customer-addresses', 'master.customer.manage');

// ---------------------------------------------------------------- vendors

r.get('/vendors', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await parties.listVendors(authOf(req), listQuery(req))); }));
r.get('/vendors/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await parties.getVendor(authOf(req), idOf(req))); }));
r.post('/vendors', requirePermission('master.vendor.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await parties.createVendor(authOf(req), CreateVendorRequest.parse(req.body)));
}));
r.patch('/vendors/:id', requirePermission('master.vendor.manage'), asyncHandler(async (req, res) => {
  res.json(await parties.updateVendor(authOf(req), idOf(req), UpdateVendorRequest.parse(req.body), requestMeta(req)));
}));
r.post('/vendors/:id/activate', requirePermission('master.vendor.approve'), asyncHandler(async (req, res) => {
  const { reason } = MasterActionRequest.parse(req.body ?? {});
  await parties.changePartyStatus(authOf(req), 'vendor', idOf(req), 'ACTIVE', reason);
  res.json(await parties.getVendor(authOf(req), idOf(req)));
}));
r.post('/vendors/:id/deactivate', requirePermission('master.vendor.approve'), asyncHandler(async (req, res) => {
  const { reason } = DeactivateRequest.parse(req.body ?? {});
  await parties.changePartyStatus(authOf(req), 'vendor', idOf(req), 'INACTIVE', reason);
  res.json(await parties.getVendor(authOf(req), idOf(req)));
}));

// ---------------------------------------------------------------- approved sources (AVL)

r.get('/approved-sources', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await avl.listSources(authOf(req), listQuery(req))); }));
r.get('/approved-sources/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await avl.getSource(authOf(req), idOf(req))); }));
r.post('/approved-sources', requirePermission('master.vendor.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await avl.proposeSource(authOf(req), CreateApprovedSourceRequest.parse(req.body)));
}));
r.post('/approved-sources/:id/block', requirePermission('master.avl.approve'), asyncHandler(async (req, res) => {
  res.json(await avl.blockSource(authOf(req), idOf(req), BlockSourceRequest.parse(req.body), requestMeta(req)));
}));

// ---------------------------------------------------------------- products (master.product.manage)

r.get('/products', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await productsSvc.listProducts(authOf(req), listQuery(req))); }));
r.get('/products/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await productsSvc.getProduct(authOf(req), idOf(req))); }));
r.post('/products', requirePermission('master.product.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await productsSvc.createProduct(authOf(req), CreateProductRequest.parse(req.body), requestMeta(req)));
}));
r.patch('/products/:id', requirePermission('master.product.manage'), asyncHandler(async (req, res) => {
  res.json(await productsSvc.updateProduct(authOf(req), idOf(req), UpdateProductRequest.parse(req.body), requestMeta(req)));
}));
activeFlagRoutes('products', 'master.product.manage');

// ---------------------------------------------------------------- master formulas (master.formula.manage; approval via core/approvals)

r.get('/formulas', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await formulas.listFormulas(authOf(req), listQuery(req))); }));
r.get('/formulas/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await formulas.getFormula(authOf(req), idOf(req))); }));
r.post('/formulas', requirePermission('master.formula.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await formulas.createFormula(authOf(req), CreateFormulaRequest.parse(req.body)));
}));
r.patch('/formulas/:id', requirePermission('master.formula.manage'), asyncHandler(async (req, res) => {
  res.json(await formulas.updateFormula(authOf(req), idOf(req), UpdateFormulaRequest.parse(req.body)));
}));
r.put('/formulas/:id/lines', requirePermission('master.formula.manage'), asyncHandler(async (req, res) => {
  res.json(await formulas.setFormulaLines(authOf(req), idOf(req), SetFormulaLinesRequest.parse(req.body)));
}));
r.post('/formulas/:id/submit', requirePermission('master.formula.manage'), asyncHandler(async (req, res) => {
  res.json(await formulas.submitFormula(authOf(req), idOf(req)));
}));

// ---------------------------------------------------------------- price lists (master.price.manage)

r.get('/price-lists', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.listPriceLists(authOf(req), listQuery(req))); }));
r.get('/price-lists/:id', requirePermission(VIEW), asyncHandler(async (req, res) => { res.json(await catalog.getPriceList(authOf(req), idOf(req))); }));
r.post('/price-lists', requirePermission('master.price.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.createPriceList(authOf(req), CreatePriceListRequest.parse(req.body)));
}));
r.patch('/price-lists/:id', requirePermission('master.price.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updatePriceList(authOf(req), idOf(req), UpdatePriceListRequest.parse(req.body)));
}));
activeFlagRoutes('price-lists', 'master.price.manage');
r.post('/price-lists/:id/lines', requirePermission('master.price.manage'), asyncHandler(async (req, res) => {
  res.status(201).json(await catalog.addPriceListLine(authOf(req), idOf(req), CreatePriceListLineRequest.parse(req.body)));
}));
r.patch('/price-list-lines/:id', requirePermission('master.price.manage'), asyncHandler(async (req, res) => {
  res.json(await catalog.updatePriceListLine(authOf(req), idOf(req), UpdatePriceListLineRequest.parse(req.body)));
}));
activeFlagRoutes('price-list-lines', 'master.price.manage');
