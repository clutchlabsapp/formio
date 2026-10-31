/* eslint-env mocha */
'use strict';

const assert = require('assert');
const _ = require('lodash');
const request = require('./formio-supertest');

// GET /form/:formId/report: grouped totals over submissions, with the caller's read access.
module.exports = function (app, template, hook) {
  const url = (path) => hook.alter('url', path, template);
  const adminToken = () => template.users.admin.token;
  const call = (method, path, payload, status, token = adminToken()) => {
    const req = request(app)[method](url(path)).set('x-jwt-token', token);
    return (payload ? req.send(payload) : req).expect(status).then((res) => res.body);
  };
  const post = (path, payload, status = 201, token) => call('post', path, payload, status, token);
  const get = (path, status = 200, token) => call('get', path, null, status, token);
  const submissionModel = () => hook.alter('formio', app.formio).resources.submission.model;
  const formModel = () => hook.alter('formio', app.formio).resources.form.model;

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const formIds = [];
  const createForm = async (name, components, extra = {}) => {
    const unique = `${suffix}${formIds.length}`;
    const form = await post('/form', {
      title: name,
      name: `${name}${unique}`,
      path: `${name.toLowerCase()}${unique}`,
      type: 'form',
      components,
      ...extra,
    });
    formIds.push(form._id);
    return form;
  };
  const field = (type, key, extra = {}) => ({ type, key, label: key, input: true, ...extra });

  let customerForm, orderForm, ada, bob;

  before('create customers and orders', async () => {
    const authenticated = template.roles.authenticated._id;
    customerForm = await createForm('Customer', [field('textfield', 'name')], { type: 'resource' });
    orderForm = await createForm(
      'Order',
      [
        field('select', 'customer', {
          dataSrc: 'resource',
          data: { resource: customerForm._id },
          reference: true,
        }),
        field('textfield', 'status'),
        field('textfield', 'secret', { protected: true }),
        field('datagrid', 'lines', {
          components: [field('textfield', 'item'), field('number', 'price')],
        }),
      ],
      {
        submissionAccess: [
          { type: 'create_own', roles: [authenticated] },
          { type: 'read_own', roles: [authenticated] },
        ],
      },
    );
    ada = await post(`/form/${customerForm._id}/submission`, { data: { name: 'Ada' } });
    bob = await post(`/form/${customerForm._id}/submission`, { data: { name: 'Bob' } });
    const order = (customer, status, prices) => ({
      data: {
        customer: { _id: customer._id },
        status,
        secret: 'x',
        lines: prices.map((price, index) => ({ item: `i${index}`, price })),
      },
    });
    await post(`/form/${orderForm._id}/submission`, order(ada, 'open', [3, 4]));
    await post(`/form/${orderForm._id}/submission`, order(ada, 'closed', [10]));
    await post(`/form/${orderForm._id}/submission`, order(bob, 'open', [1]));
    await post(
      `/form/${orderForm._id}/submission`,
      order(bob, 'open', [5, 5]),
      201,
      template.users.user1.token,
    );
  });

  after('remove the forms and submissions created by this suite', async () => {
    await submissionModel().deleteMany({ form: { $in: formIds } });
    await formModel().deleteMany({ _id: { $in: formIds } });
  });

  const report = (query, status = 200, token) =>
    get(`/form/${orderForm._id}/report?${query}`, status, token);

  it('counts submissions per linked record and returns those records for labels', async () => {
    const result = await report('groupBy=data.customer._id');
    const counts = _.fromPairs(
      result.rows.map((row) => [row.key['data.customer._id'], row.values.count]),
    );
    assert.deepStrictEqual(counts, { [ada._id]: 2, [bob._id]: 2 });
    assert.strictEqual(result.records[ada._id].data.name, 'Ada');
    assert.strictEqual(result.truncated, false);
  });

  it('sums a grid column with one row per line', async () => {
    const result = await report(
      'groupBy=data.customer._id&unwind=lines&metric=sum:data.lines.price&metric=count',
    );
    const totals = _.fromPairs(
      result.rows.map((row) => [
        row.key['data.customer._id'],
        [row.values['sum:data.lines.price'], row.values.count],
      ]),
    );
    assert.deepStrictEqual(totals, { [ada._id]: [17, 3], [bob._id]: [11, 3] });
  });

  it('applies the normal submission filters', async () => {
    const result = await report('groupBy=data.status&data.status=open');
    assert.deepStrictEqual(
      result.rows.map((row) => [row.key['data.status'], row.values.count]),
      [['open', 3]],
    );
  });

  it('buckets by date', async () => {
    const result = await report('dateBucket=created:month&metric=count');
    const month = new Date().toISOString().slice(0, 7);
    assert.deepStrictEqual(
      result.rows.map((row) => [row.key['created:month'], row.values.count]),
      [[month, 4]],
    );
  });

  it('limits a read_own caller to their own submissions', async () => {
    const result = await report(
      'unwind=lines&metric=sum:data.lines.price',
      200,
      template.users.user1.token,
    );
    assert.deepStrictEqual(
      result.rows.map((row) => row.values['sum:data.lines.price']),
      [10],
    );
  });

  it('refuses protected, unknown and malformed fields', async () => {
    await report('groupBy=data.secret', 400);
    await report('groupBy=data.nope', 400);
    await report('groupBy=$where', 400);
    await report('metric=median:data.lines.price', 400);
    await report('unwind=status', 400);
    await report('dateBucket=created:week', 400);
    await report('metric=count&data.secret=x', 400);
  });

  it('needs read access to the submissions', async () => {
    const closed = await createForm('Closed', [field('textfield', 'name')], {
      submissionAccess: [],
    });
    await get(`/form/${closed._id}/report?metric=count`, 401, template.users.user1.token);
  });
};
