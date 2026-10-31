/* eslint-env mocha */
'use strict';

const assert = require('assert');
const _ = require('lodash');
const request = require('./formio-supertest');

// Linked records: `?expand=` on submission reads and the `related` endpoint. The fixtures are
// the plan's three examples reduced to what each feature needs: Products, Customers holding a
// list of default Products, and Orders pointing at a Customer and at Products in a grid.
module.exports = function (app, template, hook) {
  const url = (path) => hook.alter('url', path, template);
  const adminToken = () => template.users.admin.token;
  const body = (res) => {
    if (
      res.headers['x-jwt-token'] &&
      res.req &&
      res.req.getHeader('x-jwt-token') === adminToken()
    ) {
      template.users.admin.token = res.headers['x-jwt-token'];
    }
    return res.body;
  };
  const call = (method, path, payload, status, token = adminToken()) => {
    const req = request(app)[method](url(path)).set('x-jwt-token', token);
    return (payload ? req.send(payload) : req).expect(status).then(body);
  };
  const post = (path, payload, status = 201, token) => call('post', path, payload, status, token);
  const get = (path, status = 200, token) => call('get', path, null, status, token);
  const submissionModel = () => hook.alter('formio', app.formio).resources.submission.model;
  const formModel = () => hook.alter('formio', app.formio).resources.form.model;

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const formIds = [];
  const createForm = async (name, components, extra = {}) => {
    const form = await post('/form', {
      title: name,
      name: `${name}${suffix}`,
      path: `${name.toLowerCase()}${suffix}`,
      type: 'resource',
      components,
      ...extra,
    });
    formIds.push(form._id);
    return form;
  };
  const textField = (key) => ({ type: 'textfield', key, label: key, input: true });
  const numberField = (key) => ({ type: 'number', key, label: key, input: true });
  const refSelect = (key, formId, extra = {}) => ({
    type: 'select',
    key,
    label: key,
    input: true,
    dataSrc: 'resource',
    data: { resource: formId },
    valueProperty: '',
    reference: true,
    ...extra,
  });

  const authenticated = () => template.roles.authenticated._id;
  const administrator = () => template.roles.administrator._id;
  // Admin reads everything; authenticated users read only their own submissions.
  const ownOnlyAccess = () => [
    { type: 'create_own', roles: [authenticated()] },
    { type: 'read_own', roles: [authenticated()] },
    { type: 'read_all', roles: [administrator()] },
    { type: 'create_all', roles: [administrator()] },
    { type: 'update_all', roles: [administrator()] },
  ];

  let productForm, customerForm, orderForm;
  let flour, eggs, customer, order;

  before('create products, a customer with default products, and an order', async () => {
    productForm = await createForm('Product', [textField('name'), numberField('price')], {
      submissionAccess: ownOnlyAccess(),
    });
    customerForm = await createForm(
      'Customer',
      [textField('name'), refSelect('defaultProducts', productForm._id, { multiple: true })],
      { submissionAccess: ownOnlyAccess() },
    );
    orderForm = await createForm(
      'Order',
      [
        refSelect('customer', customerForm._id),
        // Saved as a full copy (reference: false); `?expand=` refreshes it from the live record.
        refSelect('customerCopy', customerForm._id, { reference: false }),
        {
          type: 'datagrid',
          key: 'lines',
          label: 'Lines',
          input: true,
          components: [refSelect('product', productForm._id), numberField('qty')],
        },
      ],
      { submissionAccess: ownOnlyAccess() },
    );

    flour = await post(`/form/${productForm._id}/submission`, {
      data: { name: 'Flour', price: 3 },
    });
    eggs = await post(`/form/${productForm._id}/submission`, { data: { name: 'Eggs', price: 4 } });
    customer = await post(`/form/${customerForm._id}/submission`, {
      data: { name: 'Ada', defaultProducts: [{ _id: flour._id }, { _id: eggs._id }] },
    });
    order = await post(`/form/${orderForm._id}/submission`, {
      data: {
        customer: { _id: customer._id },
        customerCopy: { _id: customer._id, data: { name: 'Ada (old copy)' } },
        lines: [
          { product: { _id: flour._id }, qty: 2 },
          { product: { _id: eggs._id }, qty: 12 },
        ],
      },
    });
  });

  after('remove the forms and submissions created by this suite', async () => {
    await submissionModel().deleteMany({ form: { $in: formIds } });
    await formModel().deleteMany({ _id: { $in: formIds } });
  });

  describe('Linked records - unit helpers', () => {
    let linked;
    before(() => {
      linked = require('../src/util/linkedRecords')({ formio: hook.alter('formio', app.formio) });
    });

    it('finds reference components with their data paths, including inside grids', () => {
      const refs = linked.getReferenceComponents(orderForm).map((ref) => [ref.path, ref.formId]);
      assert.deepStrictEqual(refs, [
        ['customer', customerForm._id],
        ['customerCopy', customerForm._id],
        ['lines.product', productForm._id],
      ]);
    });

    it('matches the longest reference path and returns the hops left over', () => {
      const refs = linked.getReferenceComponents(orderForm);
      const match = linked.matchReferencePath(refs, ['lines', 'product', 'supplier']);
      assert.strictEqual(match.ref.path, 'lines.product');
      assert.deepStrictEqual(match.rest, ['supplier']);
      assert.strictEqual(linked.matchReferencePath(refs, ['nope']), null);
    });

    it('visits a value in every grid row and can replace it', () => {
      const data = { lines: [{ product: { _id: 'a' } }, { product: { _id: 'b' } }, {}] };
      const seen = [];
      linked.visitPath(data, 'lines.product', (value, set) => {
        seen.push(value._id);
        set({ _id: value._id, seen: true });
      });
      assert.deepStrictEqual(seen, ['a', 'b']);
      assert.deepStrictEqual(data.lines[1], { product: { _id: 'b', seen: true } });
    });
  });

  describe('Linked records - ?expand=', () => {
    it('hydrates a reference two hops deep on a single read', async () => {
      const fetched = await get(
        `/form/${orderForm._id}/submission/${order._id}?expand=customer.defaultProducts`,
      );
      assert.strictEqual(fetched.data.customer.data.name, 'Ada');
      assert.deepStrictEqual(
        fetched.data.customer.data.defaultProducts.map((product) => product.data.name),
        ['Flour', 'Eggs'],
      );
    });

    it('hydrates references inside grid rows on the index', async () => {
      const list = await get(`/form/${orderForm._id}/submission?expand=lines.product`);
      const found = list.find((item) => item._id === order._id);
      assert.ok(found, 'order should be listed');
      assert.deepStrictEqual(
        found.data.lines.map((line) => [line.product.data.name, line.qty]),
        [
          ['Flour', 2],
          ['Eggs', 12],
        ],
      );
    });

    it('refreshes a reference saved as a copy from the live record', async () => {
      const plain = await get(`/form/${orderForm._id}/submission/${order._id}`);
      assert.strictEqual(plain.data.customerCopy.data.name, 'Ada (old copy)');
      const fetched = await get(
        `/form/${orderForm._id}/submission/${order._id}?expand=customerCopy`,
      );
      assert.strictEqual(fetched.data.customerCopy.data.name, 'Ada');
    });

    it('does not treat expand as a filter on the index', async () => {
      const list = await get(`/form/${orderForm._id}/submission?expand=customer`);
      assert.ok(list.some((item) => item._id === order._id));
    });

    it('ignores paths that name no reference component', async () => {
      const fetched = await get(`/form/${orderForm._id}/submission/${order._id}?expand=nope.x`);
      assert.strictEqual(fetched._id, order._id);
    });

    it('leaves a reference as a bare _id when the caller cannot read its record', async () => {
      const user = template.users.user1;
      const ownOrder = await post(
        `/form/${orderForm._id}/submission`,
        { data: { customer: { _id: customer._id }, lines: [] } },
        201,
        user.token,
      );
      const fetched = await get(
        `/form/${orderForm._id}/submission/${ownOrder._id}?expand=customer.defaultProducts`,
        200,
        user.token,
      );
      assert.deepStrictEqual(_.pick(fetched.data.customer, ['_id', 'data']), {
        _id: customer._id,
      });
    });
  });

  describe('Linked records - related', () => {
    it('lists the forms and fields that link to a record, with counts', async () => {
      const related = await get(`/form/${productForm._id}/submission/${flour._id}/related`);
      const summary = related.map((item) => [item.form, item.field, item.count]);
      assert.deepStrictEqual(_.sortBy(summary, 1), [
        [customerForm._id, 'defaultProducts', 1],
        [orderForm._id, 'lines.product', 1],
      ]);
    });

    it('requires read access to the record itself', async () => {
      // user1 cannot read the admin's customer, so the route is refused before any counting.
      await get(
        `/form/${customerForm._id}/submission/${customer._id}/related`,
        401,
        template.users.user1.token,
      );
    });

    it('counts every linking submission for a caller with read_all', async () => {
      // The admin's order and the order user1 created in the expand tests both link here.
      const related = await get(`/form/${customerForm._id}/submission/${customer._id}/related`);
      assert.deepStrictEqual(
        related.map((item) => [item.form, item.field, item.count]),
        [
          [orderForm._id, 'customer', 2],
          [orderForm._id, 'customerCopy', 1],
        ],
      );
    });

    it('rejects a record that does not exist, like a plain read does', async () => {
      const missing = '000000000000000000000000';
      const plain = await request(app)
        .get(url(`/form/${productForm._id}/submission/${missing}`))
        .set('x-jwt-token', adminToken());
      const related = await request(app)
        .get(url(`/form/${productForm._id}/submission/${missing}/related`))
        .set('x-jwt-token', adminToken());
      assert.ok(related.status >= 400, `expected an error status, got ${related.status}`);
      assert.strictEqual(related.status, plain.status);
    });
  });
};
