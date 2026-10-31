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
// Expressions: "$item...", "$source...", "$record..." read a value (a linked record found there
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
    const match = expression.match(/^(\$item|\$source|\$record)(?:\.(.+))?$/);
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
   * Compute a grid's rows from the records currently picked in `data`.
   */
  const computeGridRows = async (req, form, grid, data, log) => {
    const { settings } = grid;
    const sourceRef = linked
      .getReferenceComponents(form)
      .find((ref) => ref.path === settings.source);
    if (!sourceRef) {
      log.debug({ formId: form._id, grid: grid.path }, 'linkedRows source is not a reference');
      return _.get(data, grid.path, []);
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

    const rows = mergeRows(settings, _.get(data, grid.path), generated);
    log.debug(
      { grid: grid.path, merge: settings.merge, generated: generated.length, rows: rows.length },
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

  return {
    LINKED_KEY,
    OPERATIONS,
    normalizeSettings,
    evaluate,
    mergeRows,
    getLinkedGrids,
    computeGridRows,
    prefill,
  };
};

module.exports.LINKED_KEY = LINKED_KEY;
module.exports.OPERATIONS = OPERATIONS;
module.exports.normalizeSettings = normalizeSettings;
module.exports.evaluate = evaluate;
module.exports.mergeRows = mergeRows;
