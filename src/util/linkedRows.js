'use strict';

const _ = require('lodash');
const util = require('./util');

// Linked rows: a grid (DataGrid / EditGrid) declares how to fill itself from records picked
// elsewhere in the same form. The server computes the rows, so the browser, API clients and
// save-time checks all get the same answer. Nothing here knows about any particular use case.
//
//   "linkedRows": {
//     "source": "recipes.recipe",   // a reference component in this form (may sit in a grid)
//     "path": "ingredients",        // a list in each picked record's data
//     "map": { "<column>": <expression>, ... },
//     "merge": "fillIfEmpty" | "append" | "replace" | "combine",
//     "key": ["ingredient", "unit"],  // combine: rows with equal key columns become one row
//     "sum": ["qty"],                 // combine: columns added together
//     "sync": "onPick" | "live"       // onPick keeps edits to generated rows; live recomputes
//   }
//
// Expressions: "$item...", "$source...", "$record..." read a value ("$target..." in a limit) (a linked record found there
// is stored as a `{ _id }` link); any other string, number or boolean is a literal; an object
// with one key from OPERATIONS computes a value from its argument list.
//
// Every generated row carries `_linked: { from: [{ record, item, sum? }] }`, naming the picked
// record (and list item) each row, or each share of a combined row, came from.

const LINKED_KEY = '_linked';
const MERGE_MODES = ['fillIfEmpty', 'append', 'replace', 'combine'];
const SYNC_MODES = ['onPick', 'live'];
const GRID_TYPES = ['datagrid', 'editgrid'];

const toNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
};
const numeric = (fn) => (args) => {
  const numbers = args.map(toNumber);
  return numbers.some((number) => number === null) ? null : fn(numbers);
};

// The fixed set of operations a mapping may use. Plain functions over already-resolved
// arguments: no user code is evaluated. `linkedRowsOperations` may add more.
const OPERATIONS = {
  add: numeric((numbers) => numbers.reduce((total, number) => total + number, 0)),
  subtract: numeric(([first, ...rest]) => rest.reduce((total, number) => total - number, first)),
  multiply: numeric((numbers) => numbers.reduce((total, number) => total * number, 1)),
  divide: numeric(([first, ...rest]) =>
    rest.some((number) => number === 0)
      ? null
      : rest.reduce((total, number) => total / number, first),
  ),
  round: (args) => {
    const [value, digits = 0] = args.map(toNumber);
    if (value === null || digits === null) {
      return null;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  },
  concat: (args) => args.map((arg) => (arg === null || arg === undefined ? '' : arg)).join(''),
};

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
// A value that is a submission (has an _id and a form or data) is stored as a link.
const asLink = (value) =>
  isRecord(value) && value._id && (value.data || value.form) ? { _id: value._id } : value;

/**
 * Check a linkedRows setting and fill in defaults. Returns { settings } or { error }.
 */
const normalizeSettings = (raw) => {
  if (!isRecord(raw)) {
    return { error: 'linkedRows must be an object' };
  }
  const settings = {
    source: raw.source,
    path: raw.path,
    map: raw.map,
    merge: raw.merge || 'fillIfEmpty',
    key: Array.isArray(raw.key) ? raw.key : [],
    sum: Array.isArray(raw.sum) ? raw.sum : [],
    sync: raw.sync || 'onPick',
    lock: raw.lock === true,
    readOnly: Array.isArray(raw.readOnly) ? raw.readOnly : [],
    limit: isRecord(raw.limit) ? raw.limit : null,
  };
  if (typeof settings.source !== 'string' || !settings.source) {
    return { error: 'linkedRows.source must name a reference component' };
  }
  if (typeof settings.path !== 'string' || !settings.path) {
    return { error: 'linkedRows.path must name a list in the picked record' };
  }
  if (!isRecord(settings.map) || !Object.keys(settings.map).length) {
    return { error: 'linkedRows.map must map at least one column' };
  }
  if (!MERGE_MODES.includes(settings.merge)) {
    return { error: `linkedRows.merge must be one of ${MERGE_MODES.join(', ')}` };
  }
  if (!SYNC_MODES.includes(settings.sync)) {
    return { error: `linkedRows.sync must be one of ${SYNC_MODES.join(', ')}` };
  }
  if (settings.merge === 'combine' && !settings.key.length) {
    return { error: 'linkedRows.key is required when merge is combine' };
  }
  return { settings };
};

/**
 * Resolve one mapping expression against { $item, $source, $record }.
 */
const evaluate = (expression, context, operations) => {
  if (typeof expression === 'string') {
    const match = expression.match(/^(\$item|\$source|\$record|\$target)(?:\.(.+))?$/);
    if (!match) {
      return expression;
    }
    const base = context[match[1]];
    const value = match[2] ? _.get(base, match[2]) : base;
    return value === undefined ? null : asLink(_.cloneDeep(value));
  }
  if (isRecord(expression)) {
    const names = Object.keys(expression);
    const operation = names.length === 1 ? operations[names[0]] : null;
    if (!operation) {
      throw new Error(`Unknown linkedRows operation: ${names.join(', ')}`);
    }
    const args = [].concat(expression[names[0]]).map((arg) => evaluate(arg, context, operations));
    return operation(args);
  }
  return expression === undefined ? null : expression;
};

/**
 * Build one row from a list item.
 */
const buildRow = (settings, context, origin, operations) => {
  const row = {};
  _.each(settings.map, (expression, column) => {
    row[column] = evaluate(expression, context, operations);
  });
  row[LINKED_KEY] = { from: [origin] };
  return row;
};

const linkId = (value) => (isRecord(value) && value._id ? value._id.toString() : null);

const rowIdentity = (row) => {
  const from = _.get(row, [LINKED_KEY, 'from', 0]);
  return from ? `${from.record}:${from.item}` : null;
};
const keyIdentity = (settings, row) =>
  JSON.stringify(
    settings.key.map((column) => {
      const value = row[column];
      return isRecord(value) && value._id ? `#${value._id}` : value;
    }),
  );

// Columns the mapping owns. Everything else on a row (a "bought" checkbox, notes) belongs to
// the user and is carried over when a row is regenerated.
const userColumns = (settings, row) => _.omit(row, [...Object.keys(settings.map), LINKED_KEY]);

/**
 * Merge freshly generated rows into a grid's current rows.
 *
 * @param settings Normalized linkedRows settings.
 * @param currentRows The grid's rows as the form holds them now.
 * @param generated Rows built from every currently picked record, in pick order.
 * @return {Array} the grid's new rows
 */
const mergeRows = (settings, currentRows, generated) => {
  const current = Array.isArray(currentRows) ? currentRows : [];
  const userRows = current.filter((row) => !isRecord(row) || !row[LINKED_KEY]);
  const linkedRows = current.filter((row) => isRecord(row) && row[LINKED_KEY]);

  if (settings.merge === 'fillIfEmpty') {
    return current.length ? current : generated;
  }

  if (settings.merge === 'combine') {
    const combined = new Map();
    generated.forEach((row) => {
      const identity = keyIdentity(settings, row);
      const share = { ...row[LINKED_KEY].from[0], sum: _.pick(row, settings.sum) };
      const existing = combined.get(identity);
      if (!existing) {
        combined.set(identity, { ...row, [LINKED_KEY]: { from: [share] } });
        return;
      }
      settings.sum.forEach((column) => {
        const total = OPERATIONS.add([existing[column], row[column]]);
        existing[column] = total === null ? existing[column] : total;
      });
      existing[LINKED_KEY].from.push(share);
    });
    const previous = new Map(linkedRows.map((row) => [keyIdentity(settings, row), row]));
    const rows = [...combined.entries()].map(([identity, row]) => {
      const before = previous.get(identity);
      return before ? { ...row, ...userColumns(settings, before) } : row;
    });
    return [...rows, ...userRows];
  }

  // append / replace: one row per list item, matched to its previous self by origin.
  const previous = new Map(linkedRows.map((row) => [rowIdentity(row), row]));
  const rows = generated.map((row) => {
    const before = previous.get(rowIdentity(row));
    if (!before) {
      return row;
    }
    // onPick: a generated row the user already has is left as they edited it.
    return settings.sync === 'live' ? { ...row, ...userColumns(settings, before) } : before;
  });
  return settings.merge === 'replace' ? rows : [...rows, ...userRows];
};

module.exports = (router) => {
  const hook = require('./hook')(router.formio);
  const linked = require('./linkedRecords')(router);

  const operations = () => hook.alter('linkedRowsOperations', { ...OPERATIONS });

  /**
   * Every grid in a form with a valid linkedRows setting.
   * @return {Array<{ path, component, settings }>}
   */
  const getLinkedGrids = (form, log) => {
    const grids = [];
    if (!form || !Array.isArray(form.components)) {
      return grids;
    }
    util.FormioUtils.eachComponent(
      form.components,
      (component, path, components, parent, paths) => {
        if (!component.linkedRows || !GRID_TYPES.includes(component.type)) {
          return;
        }
        const { settings, error } = normalizeSettings(component.linkedRows);
        if (error) {
          log.debug({ formId: form._id, grid: path, error }, 'ignoring invalid linkedRows');
          return;
        }
        // A grid inside another grid has no single place to put its rows.
        if (paths && paths.dataPath && paths.dataPath !== path) {
          log.debug({ formId: form._id, grid: path }, 'ignoring linkedRows on a nested grid');
          return;
        }
        grids.push({ path, component, settings });
      },
      true,
    );
    return grids;
  };

  /**
   * Build one row per list item of every record currently picked in `data` (not yet merged).
   */
  const generateRows = async (req, form, grid, data, log) => {
    const { settings } = grid;
    const sourceRef = linked
      .getReferenceComponents(form)
      .find((ref) => ref.path === settings.source);
    if (!sourceRef) {
      log.debug({ formId: form._id, grid: grid.path }, 'linkedRows source is not a reference');
      return null;
    }

    // Each pick: the record id and the object holding it (a grid row of picks, or the form).
    const picks = [];
    const sourceParent = settings.source.split('.').slice(0, -1).join('.');
    const holders = sourceParent ? [].concat(_.get(data, sourceParent) || []) : [data];
    const sourceKey = settings.source.split('.').pop();
    holders.forEach((holder) => {
      if (!isRecord(holder)) {
        return;
      }
      linked
        .idsOf(holder[sourceKey])
        .forEach((record) => picks.push({ record, holder: _.cloneDeep(holder) }));
    });
    log.trace({ grid: grid.path, picks: picks.length }, 'collected linkedRows picks');

    const records = await linked.loadRecords(
      req,
      sourceRef.formId,
      picks.map((pick) => pick.record),
      log,
    );
    // Hydrate the list (and references inside its rows) so mappings can read through them.
    if (records.size) {
      const sourceForm = await router.formio.cache.loadForm(req, null, sourceRef.formId);
      const listPaths = linked
        .getReferenceComponents(sourceForm)
        .map((ref) => ref.path)
        .filter((path) => path === settings.path || path.startsWith(`${settings.path}.`));
      await linked.expandSubmissions(req, sourceForm, [...records.values()], listPaths, log);
    }

    const ops = operations();
    const generated = [];
    picks.forEach((pick) => {
      const record = records.get(pick.record);
      if (!record) {
        log.debug({ grid: grid.path, record: pick.record }, 'picked record not readable');
        return;
      }
      const list = _.get(record.data, settings.path);
      [].concat(list === undefined || list === null ? [] : list).forEach((item, index) => {
        const itemId = isRecord(item) && item._id ? item._id.toString() : String(index);
        generated.push(
          buildRow(
            settings,
            { $item: item, $source: pick.holder, $record: record },
            { record: pick.record, item: itemId },
            ops,
          ),
        );
      });
    });
    log.trace({ grid: grid.path, generated: generated.length }, 'generated linked rows');
    return generated;
  };

  /**
   * Compute a grid's rows from the records currently picked in `data`.
   */
  const computeGridRows = async (req, form, grid, data, log) => {
    const generated = await generateRows(req, form, grid, data, log);
    if (!generated) {
      return _.get(data, grid.path, []);
    }
    const rows = mergeRows(grid.settings, _.get(data, grid.path), generated);
    log.debug(
      {
        grid: grid.path,
        merge: grid.settings.merge,
        generated: generated.length,
        rows: rows.length,
      },
      'computed linked rows',
    );
    return rows;
  };

  /**
   * Compute every linked grid (or only those fed by `changed`) for the given form data.
   * @return {Promise<object>} { [gridPath]: rows }
   */
  const prefill = async (req, form, data, changed, log) => {
    const result = {};
    const grids = getLinkedGrids(form, log).filter(
      (grid) =>
        !changed ||
        grid.settings.source === changed ||
        grid.settings.source.split('.')[0] === changed.split('.')[0],
    );
    for (const grid of grids) {
      result[grid.path] = await computeGridRows(req, form, grid, data, log);
    }
    return result;
  };

  // ---------------------------------------------------------------------------------------
  // Save time. The server decides which submitted rows came from a pick by matching them to
  // the rows it would generate itself, never by trusting a `_linked` value sent by the client.

  const rowsOf = (data, path) => {
    const rows = _.get(data, path);
    return Array.isArray(rows) ? rows : [];
  };

  // Match each expected (generated, or combined) row to a submitted row. A row matches on the
  // columns that hold links (or, for combine, on the key columns); with neither, on the origin
  // the client echoed back. Returns an array aligned with `rows`: the expected row or null.
  const matchRows = (settings, expected, rows, clientMarks) => {
    const matched = rows.map(() => null);
    const identity = (row, columns) =>
      JSON.stringify(columns.map((column) => linkId(row[column]) || row[column]));
    expected.forEach((want) => {
      let index = -1;
      if (settings.merge === 'combine') {
        const wanted = keyIdentity(settings, want);
        index = rows.findIndex((row, i) => !matched[i] && keyIdentity(settings, row) === wanted);
      } else {
        const columns = Object.keys(settings.map).filter((column) => linkId(want[column]));
        if (columns.length) {
          const wanted = identity(want, columns);
          index = rows.findIndex((row, i) => !matched[i] && identity(row, columns) === wanted);
        } else {
          const wanted = rowIdentity(want);
          index = rows.findIndex(
            (row, i) => !matched[i] && rowIdentity({ [LINKED_KEY]: clientMarks[i] }) === wanted,
          );
        }
      }
      if (index !== -1) {
        matched[index] = want;
      }
    });
    return matched;
  };

  const validationError = (details) => ({
    name: 'ValidationError',
    details: details.map(({ message, path }) => ({ message, path: path.split('.'), context: {} })),
  });

  // Count rows per linked target id at `grid.field`.
  const countTargets = (rows, field) => {
    const counts = new Map();
    rows.forEach((row) => {
      const id = isRecord(row) ? linkId(row[field]) : null;
      if (id) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    });
    return counts;
  };

  /**
   * Link limits: cap how many rows across this form may link to one target record. The count
   * lives on the target (`metadata.linkCounts`) and moves with a conditional `$inc`, so two
   * saves racing for the last place cannot both win. Works without transactions.
   */
  const reserveLimits = async (req, form, grid, rows, previousRows, log) => {
    const { limit } = grid.settings;
    const reservations = [];
    if (!limit || typeof limit.field !== 'string') {
      return { reservations };
    }
    const targetRef = linked
      .getReferenceComponents(form)
      .find((ref) => ref.path === `${grid.path}.${limit.field}`);
    if (!targetRef) {
      log.debug(
        { grid: grid.path, field: limit.field },
        'linkedRows limit field is not a reference',
      );
      return { reservations };
    }
    const now = countTargets(rows, limit.field);
    const before = countTargets(previousRows, limit.field);
    const targets = _.uniq([...now.keys(), ...before.keys()]);
    const counterKey = `metadata.linkCounts.${`${form._id}_${grid.path}_${limit.field}`.replace(
      /[.$]/g,
      '_',
    )}`;
    const targetForm = await router.formio.cache.loadForm(req, null, targetRef.formId);
    const model = await linked.withSubmissionModel(req, targetForm, async (found) => found);
    const ownModel = await linked.withSubmissionModel(req, form, async (found) => found);
    const ops = operations();

    for (const target of targets) {
      const delta = (now.get(target) || 0) - (before.get(target) || 0);
      if (!delta) {
        continue;
      }
      if (delta < 0) {
        // Released only once the save succeeds.
        reservations.push({ model, target, counterKey, delta, settled: false, onSuccess: true });
        continue;
      }
      const record = await model
        .findOne({ _id: util.ObjectId(target), deleted: { $eq: null } })
        .lean();
      if (!record) {
        continue;
      }
      const max = toNumber(
        evaluate(limit.max, { $item: record, $target: record, $record: record }, ops),
      );
      if (max === null) {
        continue;
      }
      // Seed the counter from the rows that already exist the first time a target is limited.
      if (!_.has(record, counterKey)) {
        const idMatch = { $in: [util.ObjectId(target), target] };
        const linkPath = `data.${grid.path}.${limit.field}._id`;
        const match = { form: form._id, deleted: { $eq: null }, [linkPath]: idMatch };
        if (req.subId) {
          match._id = { $ne: util.ObjectId(req.subId) };
        }
        const [counted] = await ownModel.aggregate([
          { $match: match },
          { $unwind: `$data.${grid.path}` },
          { $match: { [linkPath]: idMatch } },
          { $count: 'n' },
        ]);
        const existing = (counted ? counted.n : 0) + (before.get(target) || 0);
        await model.updateOne(
          { _id: record._id, [counterKey]: { $exists: false } },
          { $set: { [counterKey]: existing } },
        );
        log.debug({ target, existing }, 'seeded link limit counter');
      }
      const reserved = await model.updateOne(
        { _id: record._id, [counterKey]: { $lte: max - delta } },
        { $inc: { [counterKey]: delta } },
      );
      if (!reserved.modifiedCount) {
        log.info({ grid: grid.path, target, max }, 'link limit reached');
        return {
          reservations,
          error: {
            message: `${grid.component.label || grid.path}: ${target} has no places left (limit ${max})`,
            path: `${grid.path}.${limit.field}`,
          },
        };
      }
      log.debug({ grid: grid.path, target, delta }, 'reserved link limit places');
      reservations.push({ model, target, counterKey, delta, settled: false, onSuccess: false });
    }
    return { reservations };
  };

  /**
   * Finish reservations once the outcome of the save is known: on success apply the releases
   * (rows removed); on failure give back the places reserved.
   */
  const settle = async (reservations, success, log) => {
    for (const reservation of reservations) {
      if (reservation.settled) {
        continue;
      }
      reservation.settled = true;
      const apply = success ? reservation.onSuccess : !reservation.onSuccess;
      if (!apply) {
        continue;
      }
      const delta = success ? reservation.delta : -reservation.delta;
      await reservation.model.updateOne(
        { _id: util.ObjectId(reservation.target), [reservation.counterKey]: { $exists: true } },
        { $inc: { [reservation.counterKey]: delta } },
      );
      log.debug({ target: reservation.target, delta, success }, 'settled link limit places');
    }
  };

  /**
   * Check and prepare a submission's linked grids before it is saved.
   *
   * @return {Promise<{ errors: Array, marks: object, reservations: Array }>}
   *   marks: { [gridPath]: Array<_linked|null> } aligned with the submitted rows, to re-attach
   *   after validation (which drops keys no component owns).
   */
  const prepareSave = async (req, form, data, previousData, log) => {
    const result = { errors: [], marks: {}, reservations: [] };
    const grids = getLinkedGrids(form, log);
    for (const grid of grids) {
      const { settings } = grid;
      const rows = rowsOf(data, grid.path);
      const previousRows = rowsOf(previousData, grid.path);
      const clientMarks = rows.map((row) => (isRecord(row) ? row[LINKED_KEY] : null));

      const generated = await generateRows(req, form, grid, data, log);
      if (generated) {
        const expected =
          settings.merge === 'combine' ? mergeRows(settings, [], generated) : generated;
        const matched = matchRows(settings, expected, rows, clientMarks);

        // lock: every row a pick generates must still be there.
        if (settings.lock) {
          expected
            .filter((want) => !matched.includes(want))
            .forEach((want) => {
              const origin = want[LINKED_KEY].from[0];
              result.errors.push({
                message: `${grid.component.label || grid.path}: a row from ${origin.record} is required and cannot be removed`,
                path: grid.path,
              });
            });
        }

        // readOnly: generated values cannot be edited. On an update, a row keeps the value it
        // was saved with (a price frozen at order time stays frozen).
        if (settings.readOnly.length) {
          const previousMatched = previousRows.length
            ? matchRows(
                settings,
                expected,
                previousRows,
                previousRows.map(() => null),
              )
            : [];
          matched.forEach((want, index) => {
            if (!want) {
              return;
            }
            const previousIndex = previousMatched.indexOf(want);
            const source = previousIndex !== -1 ? previousRows[previousIndex] : want;
            settings.readOnly.forEach((column) => {
              if (_.has(source, column)) {
                rows[index][column] = _.cloneDeep(source[column]);
              }
            });
          });
        }

        result.marks[grid.path] = matched.map((want) => (want ? want[LINKED_KEY] : null));
      }

      const limits = await reserveLimits(req, form, grid, rows, previousRows, log);
      result.reservations.push(...limits.reservations);
      if (limits.error) {
        result.errors.push(limits.error);
      }
    }
    result.errors = hook.alter('linkedRowsValidate', result.errors, {
      req,
      form,
      data,
      previousData,
    });
    return result;
  };

  /**
   * Give back the link-limit places a deleted submission's rows held.
   */
  const releaseLimits = async (req, form, data, log) => {
    const reservations = [];
    for (const grid of getLinkedGrids(form, log)) {
      if (!grid.settings.limit) {
        continue;
      }
      const limits = await reserveLimits(req, form, grid, [], rowsOf(data, grid.path), log);
      reservations.push(...limits.reservations);
    }
    await settle(reservations, true, log);
  };

  /**
   * Put the server-made `_linked` markers back on the rows after validation.
   */
  const restoreMarks = (data, marks) => {
    _.each(marks, (gridMarks, path) => {
      const rows = rowsOf(data, path);
      rows.forEach((row, index) => {
        if (!isRecord(row)) {
          return;
        }
        if (gridMarks[index]) {
          row[LINKED_KEY] = gridMarks[index];
        } else {
          delete row[LINKED_KEY];
        }
      });
    });
  };

  /**
   * Merge picks into an existing submission's data and recompute the grid. Used by the push
   * endpoint: `picks` holds values for the grid's source, e.g. { recipes: [{ recipe, servings }] }.
   */
  const pushPicks = async (req, form, grid, data, picks, log) => {
    const next = _.cloneDeep(data || {});
    const { source } = grid.settings;
    const [top] = source.split('.');
    const incoming = _.get(picks, top);
    if (incoming === undefined) {
      return { error: `push body must include data.${top}` };
    }
    const current = _.get(next, top);
    if (source.includes('.') || Array.isArray(current) || Array.isArray(incoming)) {
      _.set(next, top, [...[].concat(current || []), ...[].concat(incoming)]);
    } else {
      _.set(next, top, incoming);
    }
    _.set(next, grid.path, await computeGridRows(req, form, grid, next, log));
    return { data: next };
  };

  return {
    LINKED_KEY,
    OPERATIONS,
    normalizeSettings,
    evaluate,
    mergeRows,
    getLinkedGrids,
    generateRows,
    computeGridRows,
    prefill,
    prepareSave,
    restoreMarks,
    settle,
    releaseLimits,
    pushPicks,
    validationError,
  };
};

module.exports.LINKED_KEY = LINKED_KEY;
module.exports.OPERATIONS = OPERATIONS;
module.exports.normalizeSettings = normalizeSettings;
module.exports.evaluate = evaluate;
module.exports.mergeRows = mergeRows;
