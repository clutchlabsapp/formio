/* eslint-env mocha */
'use strict';

const assert = require('assert');
const _ = require('lodash');
const request = require('./formio-supertest');
const linkedRowsLib = require('../src/util/linkedRows');

// Linked rows: a grid fills itself from records picked elsewhere in the form. The unit tests
// pin the mapping and merge rules; the API tests run the plan's examples (an order filled from
// a customer's default products, a shopping list combined from recipes) as fixtures only.
module.exports = function (app, template, hook) {
  const url = (path) => hook.alter('url', path, template);
  const adminToken = () => template.users.admin.token;
  const call = (method, path, payload, status, token = adminToken()) => {
    const req = request(app)[method](url(path)).set('x-jwt-token', token);
    return (payload ? req.send(payload) : req).expect(status).then((res) => res.body);
  };
  const post = (path, payload, status = 201, token) => call('post', path, payload, status, token);
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
    reference: true,
    ...extra,
  });
  const grid = (key, components, extra = {}) => ({
    type: 'datagrid',
    key,
    label: key,
    input: true,
    components,
    ...extra,
  });

  after('remove the forms and submissions created by this suite', async () => {
    await submissionModel().deleteMany({ form: { $in: formIds } });
    await formModel().deleteMany({ _id: { $in: formIds } });
  });

  describe('Linked rows - settings', () => {
    it('fills in defaults', () => {
      const { settings } = linkedRowsLib.normalizeSettings({
        source: 'customer',
        path: 'defaultProducts',
        map: { product: '$item' },
      });
      assert.strictEqual(settings.merge, 'fillIfEmpty');
      assert.strictEqual(settings.sync, 'onPick');
    });

    it('rejects settings it cannot run', () => {
      const bad = [
        {},
        { source: 'a', path: 'b', map: {} },
        { source: 'a', path: 'b', map: { x: 1 }, merge: 'weird' },
        { source: 'a', path: 'b', map: { x: 1 }, merge: 'combine' },
        { source: 'a', path: 'b', map: { x: 1 }, sync: 'sometimes' },
      ];
      bad.forEach((raw) => assert.ok(linkedRowsLib.normalizeSettings(raw).error, raw));
    });
  });

  describe('Linked rows - expressions', () => {
    const ops = linkedRowsLib.OPERATIONS;
    const context = {
      $item: { _id: 'p1', form: 'f', data: { price: 2.5, name: 'Flour' }, qty: 3 },
      $source: { servings: 6 },
      $record: { data: { servings: 4 } },
    };
    const run = (expression) => linkedRowsLib.evaluate(expression, context, ops);

    it('stores a linked record as a link and copies plain values', () => {
      assert.deepStrictEqual(run('$item'), { _id: 'p1' });
      assert.strictEqual(run('$item.data.price'), 2.5);
      assert.strictEqual(run('$item.missing'), null);
    });

    it('treats other values as literals', () => {
      assert.strictEqual(run('each'), 'each');
      assert.strictEqual(run(1), 1);
      assert.strictEqual(run(false), false);
    });

    it('computes with the fixed operations', () => {
      assert.strictEqual(
        run({ multiply: ['$item.qty', { divide: ['$source.servings', '$record.data.servings'] }] }),
        4.5,
      );
      assert.strictEqual(run({ add: [1, 2, '3'] }), 6);
      assert.strictEqual(run({ subtract: [10, 4] }), 6);
      assert.strictEqual(run({ round: [{ divide: [10, 3] }, 2] }), 3.33);
      assert.strictEqual(run({ concat: ['$item.data.name', ' x', '$item.qty'] }), 'Flour x3');
    });

    it('returns null instead of NaN or Infinity', () => {
      assert.strictEqual(run({ divide: [1, 0] }), null);
      assert.strictEqual(run({ multiply: ['$item.data.name', 2] }), null);
    });

    it('refuses operations it does not know', () => {
      assert.throws(() => run({ eval: ['1+1'] }), /Unknown linkedRows operation/);
    });
  });

  describe('Linked rows - merging', () => {
    const settingsFor = (raw) =>
      linkedRowsLib.normalizeSettings({
        source: 's',
        path: 'p',
        map: { item: '$item', qty: 1 },
        ...raw,
      }).settings;
    const row = (record, item, extra = {}) => ({
      item: { _id: item },
      qty: 1,
      ...extra,
      _linked: { from: [{ record, item }] },
    });

    it('fillIfEmpty only fills an empty grid', () => {
      const settings = settingsFor({ merge: 'fillIfEmpty' });
      assert.deepStrictEqual(linkedRowsLib.mergeRows(settings, [], [row('r', 'a')]), [
        row('r', 'a'),
      ]);
      const existing = [{ item: { _id: 'x' }, qty: 9 }];
      assert.deepStrictEqual(
        linkedRowsLib.mergeRows(settings, existing, [row('r', 'a')]),
        existing,
      );
    });

    it('append keeps user rows and edits, adds new picks and drops removed ones', () => {
      const settings = settingsFor({ merge: 'append' });
      const current = [
        row('r1', 'a', { qty: 5 }),
        row('r2', 'b'),
        { item: { _id: 'mine' }, qty: 2 },
      ];
      const merged = linkedRowsLib.mergeRows(settings, current, [row('r1', 'a'), row('r3', 'c')]);
      assert.deepStrictEqual(merged, [
        row('r1', 'a', { qty: 5 }),
        row('r3', 'c'),
        { item: { _id: 'mine' }, qty: 2 },
      ]);
    });

    it('replace drops user rows', () => {
      const settings = settingsFor({ merge: 'replace' });
      const merged = linkedRowsLib.mergeRows(
        settings,
        [{ item: { _id: 'mine' } }],
        [row('r', 'a')],
      );
      assert.deepStrictEqual(merged, [row('r', 'a')]);
    });

    it("live sync recomputes mapped columns but keeps the user's own columns", () => {
      const settings = settingsFor({ merge: 'append', sync: 'live' });
      const merged = linkedRowsLib.mergeRows(
        settings,
        [row('r', 'a', { qty: 5, note: 'keep me' })],
        [row('r', 'a', { qty: 2 })],
      );
      assert.deepStrictEqual(merged, [row('r', 'a', { qty: 2, note: 'keep me' })]);
    });

    it('combine adds matching rows, records each share and keeps user columns', () => {
      const settings = settingsFor({ merge: 'combine', key: ['item', 'unit'], sum: ['qty'] });
      const generated = [
        {
          item: { _id: 'flour' },
          unit: 'g',
          qty: 200,
          _linked: { from: [{ record: 'cake', item: '0' }] },
        },
        {
          item: { _id: 'flour' },
          unit: 'g',
          qty: 300,
          _linked: { from: [{ record: 'bread', item: '0' }] },
        },
        {
          item: { _id: 'flour' },
          unit: 'kg',
          qty: 1,
          _linked: { from: [{ record: 'bread', item: '1' }] },
        },
      ];
      const previous = [
        { item: { _id: 'flour' }, unit: 'g', qty: 200, bought: true, _linked: { from: [] } },
        { item: { _id: 'salt' }, qty: 1 },
      ];
      assert.deepStrictEqual(linkedRowsLib.mergeRows(settings, previous, generated), [
        {
          item: { _id: 'flour' },
          unit: 'g',
          qty: 500,
          bought: true,
          _linked: {
            from: [
              { record: 'cake', item: '0', sum: { qty: 200 } },
              { record: 'bread', item: '0', sum: { qty: 300 } },
            ],
          },
        },
        {
          item: { _id: 'flour' },
          unit: 'kg',
          qty: 1,
          _linked: { from: [{ record: 'bread', item: '1', sum: { qty: 1 } }] },
        },
        { item: { _id: 'salt' }, qty: 1 },
      ]);
    });
  });

  describe('Linked rows - prefill', () => {
    let productForm, customerForm, orderForm, ingredientForm, recipeForm, listForm;
    let flour, eggs, customer, salt, sugar, cake, bread;

    before('create the example forms and records', async () => {
      productForm = await createForm('Product', [textField('name'), numberField('price')]);
      customerForm = await createForm('Customer', [
        textField('name'),
        refSelect('defaultProducts', productForm._id, { multiple: true }),
      ]);
      orderForm = await createForm('Order', [
        refSelect('customer', customerForm._id),
        grid(
          'lines',
          [refSelect('product', productForm._id), numberField('price'), numberField('qty')],
          {
            linkedRows: {
              source: 'customer',
              path: 'defaultProducts',
              map: { product: '$item', price: '$item.data.price', qty: 1 },
            },
          },
        ),
      ]);

      ingredientForm = await createForm('Ingredient', [textField('name')]);
      recipeForm = await createForm('Recipe', [
        textField('name'),
        numberField('servings'),
        grid('ingredients', [
          refSelect('ingredient', ingredientForm._id),
          numberField('qty'),
          textField('unit'),
        ]),
      ]);
      listForm = await createForm('ShoppingList', [
        grid('recipes', [refSelect('recipe', recipeForm._id), numberField('servings')]),
        grid(
          'items',
          [
            refSelect('ingredient', ingredientForm._id),
            numberField('qty'),
            textField('unit'),
            { type: 'checkbox', key: 'bought', label: 'bought', input: true },
          ],
          {
            linkedRows: {
              source: 'recipes.recipe',
              path: 'ingredients',
              map: {
                ingredient: '$item.ingredient',
                unit: '$item.unit',
                qty: {
                  multiply: [
                    '$item.qty',
                    { divide: ['$source.servings', '$record.data.servings'] },
                  ],
                },
              },
              merge: 'combine',
              key: ['ingredient', 'unit'],
              sum: ['qty'],
              sync: 'live',
            },
          },
        ),
      ]);

      flour = await post(`/form/${productForm._id}/submission`, {
        data: { name: 'Flour', price: 3 },
      });
      eggs = await post(`/form/${productForm._id}/submission`, {
        data: { name: 'Eggs', price: 4 },
      });
      customer = await post(`/form/${customerForm._id}/submission`, {
        data: { name: 'Ada', defaultProducts: [{ _id: flour._id }, { _id: eggs._id }] },
      });

      salt = await post(`/form/${ingredientForm._id}/submission`, { data: { name: 'Salt' } });
      sugar = await post(`/form/${ingredientForm._id}/submission`, { data: { name: 'Sugar' } });
      cake = await post(`/form/${recipeForm._id}/submission`, {
        data: {
          name: 'Cake',
          servings: 4,
          ingredients: [
            { ingredient: { _id: sugar._id }, qty: 200, unit: 'g' },
            { ingredient: { _id: salt._id }, qty: 1, unit: 'tsp' },
          ],
        },
      });
      bread = await post(`/form/${recipeForm._id}/submission`, {
        data: {
          name: 'Bread',
          servings: 2,
          ingredients: [{ ingredient: { _id: salt._id }, qty: 2, unit: 'tsp' }],
        },
      });
    });

    const prefill = (form, data, changed, status = 200, token) =>
      post(`/form/${form._id}/prefill`, { data, changed }, status, token);

    it("fills a grid from a picked record's list, copying and linking values", async () => {
      const result = await prefill(orderForm, { customer: { _id: customer._id }, lines: [] });
      assert.deepStrictEqual(
        result.data.lines.map((line) => _.omit(line, '_linked')),
        [
          { product: { _id: flour._id }, price: 3, qty: 1 },
          { product: { _id: eggs._id }, price: 4, qty: 1 },
        ],
      );
      assert.deepStrictEqual(result.data.lines[0]._linked, {
        from: [{ record: customer._id, item: flour._id }],
      });
    });

    it('leaves a filled grid alone with fillIfEmpty', async () => {
      const lines = [{ product: { _id: eggs._id }, price: 4, qty: 6 }];
      const result = await prefill(orderForm, { customer: { _id: customer._id }, lines });
      assert.deepStrictEqual(result.data.lines, lines);
    });

    it("combines rows from several picks, scaled by each pick's inputs", async () => {
      const result = await prefill(listForm, {
        recipes: [
          { recipe: { _id: cake._id }, servings: 8 },
          { recipe: { _id: bread._id }, servings: 1 },
        ],
        items: [],
      });
      assert.deepStrictEqual(
        result.data.items.map((item) => [item.ingredient._id, item.qty, item.unit]),
        [
          [sugar._id, 400, 'g'],
          [salt._id, 3, 'tsp'],
        ],
      );
      assert.deepStrictEqual(
        result.data.items[1]._linked.from.map((share) => [share.record, share.sum.qty]),
        [
          [cake._id, 2],
          [bread._id, 1],
        ],
      );
    });

    it("removes only one pick's share when that pick is removed, keeping user columns", async () => {
      const first = await prefill(listForm, {
        recipes: [
          { recipe: { _id: cake._id }, servings: 4 },
          { recipe: { _id: bread._id }, servings: 2 },
        ],
        items: [],
      });
      const items = first.data.items.map((item) => ({ ...item, bought: item.unit === 'tsp' }));
      const second = await prefill(
        listForm,
        { recipes: [{ recipe: { _id: bread._id }, servings: 2 }], items },
        'recipes',
      );
      assert.deepStrictEqual(
        second.data.items.map((item) => [item.ingredient._id, item.qty, item.bought]),
        [[salt._id, 2, true]],
      );
    });

    it('only computes grids fed by the changed field', async () => {
      const result = await prefill(orderForm, { customer: { _id: customer._id } }, 'somethingElse');
      assert.deepStrictEqual(result.data, {});
    });

    it('needs create access on the form', async () => {
      const locked = await createForm(
        'Locked',
        [
          refSelect('customer', customerForm._id),
          grid('lines', [numberField('qty')], {
            linkedRows: { source: 'customer', path: 'defaultProducts', map: { qty: 1 } },
          }),
        ],
        { submissionAccess: [] },
      );
      await prefill(
        locked,
        { customer: { _id: customer._id } },
        undefined,
        401,
        template.users.user1.token,
      );
    });

    it('skips picked records the caller cannot read', async () => {
      const privateCustomers = await createForm(
        'PrivateCustomer',
        [textField('name'), refSelect('defaultProducts', productForm._id, { multiple: true })],
        { submissionAccess: [{ type: 'read_all', roles: [template.roles.administrator._id] }] },
      );
      const hidden = await post(`/form/${privateCustomers._id}/submission`, {
        data: { name: 'Hidden', defaultProducts: [{ _id: flour._id }] },
      });
      const openOrder = await createForm(
        'OpenOrder',
        [
          refSelect('customer', privateCustomers._id),
          grid('lines', [refSelect('product', productForm._id)], {
            linkedRows: { source: 'customer', path: 'defaultProducts', map: { product: '$item' } },
          }),
        ],
        { submissionAccess: [{ type: 'create_own', roles: [template.roles.authenticated._id] }] },
      );
      const asUser = await prefill(
        openOrder,
        { customer: { _id: hidden._id }, lines: [] },
        undefined,
        200,
        template.users.user1.token,
      );
      assert.deepStrictEqual(asUser.data.lines, []);
      const asAdmin = await prefill(openOrder, { customer: { _id: hidden._id }, lines: [] });
      assert.strictEqual(asAdmin.data.lines.length, 1);
    });
  });

  describe('Linked rows - save rules', () => {
    const put = (path, payload, status = 200, token) => call('put', path, payload, status, token);
    const del = (path, status = 200, token) => call('delete', path, null, status, token);
    const raw = async (id) =>
      JSON.parse(JSON.stringify((await submissionModel().findById(id).lean()).data));

    let courseForm, sectionForm, programForm, bookingForm;
    let maths, art, mathsA, program;
    let productForm, orderForm, flour, customer;
    let ingredientForm, recipeForm, listForm, salt, cake, bread;

    before('create the booking, order and shopping list examples', async () => {
      courseForm = await createForm('Course', [textField('name')]);
      sectionForm = await createForm('Section', [
        refSelect('course', courseForm._id),
        numberField('capacity'),
      ]);
      programForm = await createForm('Program', [
        textField('name'),
        refSelect('requiredCourses', courseForm._id, { multiple: true }),
      ]);
      bookingForm = await createForm(
        'Booking',
        [
          refSelect('program', programForm._id),
          grid(
            'courses',
            [refSelect('course', courseForm._id), refSelect('section', sectionForm._id)],
            {
              linkedRows: {
                source: 'program',
                path: 'requiredCourses',
                map: { course: '$item' },
                merge: 'append',
                lock: true,
                limit: { field: 'section', max: '$target.data.capacity' },
              },
            },
          ),
        ],
        {
          submissionAccess: [
            { type: 'create_own', roles: [template.roles.authenticated._id] },
            { type: 'read_own', roles: [template.roles.authenticated._id] },
            { type: 'update_own', roles: [template.roles.authenticated._id] },
            { type: 'delete_own', roles: [template.roles.authenticated._id] },
          ],
        },
      );
      maths = await post(`/form/${courseForm._id}/submission`, { data: { name: 'Maths' } });
      art = await post(`/form/${courseForm._id}/submission`, { data: { name: 'Art' } });
      mathsA = await post(`/form/${sectionForm._id}/submission`, {
        data: { course: { _id: maths._id }, capacity: 1 },
      });
      program = await post(`/form/${programForm._id}/submission`, {
        data: { name: 'Science', requiredCourses: [{ _id: maths._id }] },
      });

      productForm = await createForm('Product', [textField('name'), numberField('price')]);
      const customerForm = await createForm('Customer', [
        refSelect('defaultProducts', productForm._id, { multiple: true }),
      ]);
      orderForm = await createForm('Order', [
        refSelect('customer', customerForm._id),
        grid('lines', [refSelect('product', productForm._id), numberField('price')], {
          linkedRows: {
            source: 'customer',
            path: 'defaultProducts',
            map: { product: '$item', price: '$item.data.price' },
            readOnly: ['price'],
          },
        }),
      ]);
      flour = await post(`/form/${productForm._id}/submission`, {
        data: { name: 'Flour', price: 3 },
      });
      customer = await post(`/form/${customerForm._id}/submission`, {
        data: { defaultProducts: [{ _id: flour._id }] },
      });

      ingredientForm = await createForm('Ingredient', [textField('name')]);
      recipeForm = await createForm('Recipe', [
        numberField('servings'),
        grid('ingredients', [
          refSelect('ingredient', ingredientForm._id),
          numberField('qty'),
          textField('unit'),
        ]),
      ]);
      listForm = await createForm('ShoppingList', [
        grid('recipes', [refSelect('recipe', recipeForm._id), numberField('servings')]),
        grid(
          'items',
          [refSelect('ingredient', ingredientForm._id), numberField('qty'), textField('unit')],
          {
            linkedRows: {
              source: 'recipes.recipe',
              path: 'ingredients',
              map: { ingredient: '$item.ingredient', unit: '$item.unit', qty: '$item.qty' },
              merge: 'combine',
              key: ['ingredient', 'unit'],
              sum: ['qty'],
              sync: 'live',
            },
          },
        ),
      ]);
      salt = await post(`/form/${ingredientForm._id}/submission`, { data: { name: 'Salt' } });
      cake = await post(`/form/${recipeForm._id}/submission`, {
        data: {
          servings: 4,
          ingredients: [{ ingredient: { _id: salt._id }, qty: 1, unit: 'tsp' }],
        },
      });
      bread = await post(`/form/${recipeForm._id}/submission`, {
        data: {
          servings: 2,
          ingredients: [{ ingredient: { _id: salt._id }, qty: 2, unit: 'tsp' }],
        },
      });
    });

    it('stores server-made origin markers and ignores forged ones', async () => {
      const booking = await post(`/form/${bookingForm._id}/submission`, {
        data: {
          program: { _id: program._id },
          courses: [
            { course: { _id: maths._id }, _linked: { from: [{ record: 'forged', item: 'x' }] } },
            {
              course: { _id: art._id },
              _linked: { from: [{ record: program._id, item: art._id }] },
            },
          ],
        },
      });
      const stored = await raw(booking._id);
      assert.deepStrictEqual(stored.courses[0]._linked, {
        from: [{ record: program._id, item: maths._id }],
      });
      assert.strictEqual(stored.courses[1]._linked, undefined, 'an elective has no origin');
    });

    it('rejects a save that drops a locked row', async () => {
      const res = await post(
        `/form/${bookingForm._id}/submission`,
        { data: { program: { _id: program._id }, courses: [{ course: { _id: art._id } }] } },
        400,
      );
      assert.match(res.details[0].message, /required and cannot be removed/);
    });

    it('caps how many rows may link to one record, and frees places on failure and delete', async () => {
      const booking = (section) => ({
        data: {
          program: { _id: program._id },
          courses: [{ course: { _id: maths._id }, section: { _id: section } }],
        },
      });
      const user = template.users.user1;
      // A save that fails for another reason must not keep the place it reserved.
      await post(
        `/form/${bookingForm._id}/submission`,
        { data: { program: { _id: program._id }, courses: [{ section: { _id: mathsA._id } }] } },
        400,
      );
      const first = await post(`/form/${bookingForm._id}/submission`, booking(mathsA._id));
      const full = await post(
        `/form/${bookingForm._id}/submission`,
        booking(mathsA._id),
        400,
        user.token,
      );
      assert.match(full.details[0].message, /no places left/);
      // Moving the first booking off the section frees it.
      await put(`/form/${bookingForm._id}/submission/${first._id}`, {
        data: { program: { _id: program._id }, courses: [{ course: { _id: maths._id } }] },
      });
      const second = await post(
        `/form/${bookingForm._id}/submission`,
        booking(mathsA._id),
        201,
        user.token,
      );
      await del(`/form/${bookingForm._id}/submission/${second._id}`, 200, user.token);
      await post(`/form/${bookingForm._id}/submission`, booking(mathsA._id));
    });

    it('keeps readOnly values as generated on create and as saved on update', async () => {
      const order = await post(`/form/${orderForm._id}/submission`, {
        data: {
          customer: { _id: customer._id },
          lines: [{ product: { _id: flour._id }, price: 0.01 }],
        },
      });
      assert.strictEqual((await raw(order._id)).lines[0].price, 3);
      await put(`/form/${productForm._id}/submission/${flour._id}`, {
        data: { name: 'Flour', price: 5 },
      });
      await put(`/form/${orderForm._id}/submission/${order._id}`, {
        data: {
          customer: { _id: customer._id },
          lines: [{ product: { _id: flour._id }, price: 99 }],
        },
      });
      assert.strictEqual((await raw(order._id)).lines[0].price, 3, 'price frozen at order time');
    });

    it('pushes picks into an existing record and recomputes its grid', async () => {
      const list = await post(`/form/${listForm._id}/submission`, {
        data: {
          recipes: [{ recipe: { _id: cake._id }, servings: 4 }],
          items: [{ ingredient: { _id: salt._id }, qty: 1, unit: 'tsp' }],
        },
      });
      const updated = await put(`/form/${listForm._id}/submission/${list._id}/rows/items`, {
        data: { recipes: [{ recipe: { _id: bread._id }, servings: 2 }] },
      });
      assert.strictEqual(updated.data.recipes.length, 2);
      const stored = await raw(list._id);
      assert.deepStrictEqual(
        stored.items.map((item) => [item.ingredient._id, item.qty, item.unit]),
        [[salt._id, 3, 'tsp']],
      );
      assert.strictEqual(stored.items[0]._linked.from.length, 2);
    });

    it('needs update access on the record to push into it', async () => {
      const list = await post(`/form/${listForm._id}/submission`, {
        data: { recipes: [], items: [] },
      });
      await put(
        `/form/${listForm._id}/submission/${list._id}/rows/items`,
        { data: { recipes: [{ recipe: { _id: bread._id }, servings: 2 }] } },
        401,
        template.users.user1.token,
      );
    });

    it('returns 404 for a field without linked rows', async () => {
      const list = await post(`/form/${listForm._id}/submission`, { data: { recipes: [] } });
      await put(`/form/${listForm._id}/submission/${list._id}/rows/recipes`, { data: {} }, 404);
    });
  });
};
