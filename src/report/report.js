'use strict';

const _ = require('lodash');
const util = require('../util/util');
const metrics = require('../util/metrics');

// Reports: grouped totals over a form's submissions, for admins viewing data in the portal.
//
//   GET /form/:formId/report
//     ?groupBy=data.customer._id[,created]  fields to group by (at most 3)
//     &metric=count&metric=sum:data.lines.price   count | sum|avg|min|max:<field>  (at most 6)
//     &dateBucket=created:month               created|modified|data.<date>: day|month|year
//     &unwind=lines                           one row per line of this grid before grouping
//     &limit=500                              groups returned (default 500, max 5000)
//     &<normal submission filters>            e.g. data.status=open, created__gt=2026-01-01
//
// Access: params.js maps `report` onto the submission index, so the caller needs read access
// to the form's submissions. A read_own caller gets totals over their own submissions only.
// The pipeline uses $match / $unwind / $group / $sort / $limit and $dateToString / $substrCP,
// which MongoDB, DocumentDB and CosmosDB all run.

const REPORT_PARAMS = ['groupBy', 'metric', 'dateBucket', 'unwind', 'limit'];
const METRIC_OPS = ['sum', 'avg', 'min', 'max'];
const DATE_UNITS = { day: ['%Y-%m-%d', 10], month: ['%Y-%m', 7], year: ['%Y', 4] };
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MAX_TIME_MS = 15000;
const TOP_LEVEL_FIELDS = ['created', 'modified', 'owner', '_id'];

const asList = (value) =>
  []
    .concat(value === undefined ? [] : value)
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);

module.exports = (router) => {
  const hook = require('../util/hook')(router.formio);
  const linked = require('../util/linkedRecords')(router);

  // The components a field path may read, keyed by data path ("lines.price"). Fields that are
  // protected, encrypted or passwords cannot be grouped or summed.
  const fieldCatalog = (form) => {
    const catalog = new Map();
    util.FormioUtils.eachComponent(
      form.components,
      (component, path) => {
        if (component.input && component.key && path) {
          catalog.set(path, component);
        }
      },
      true,
    );
    return catalog;
  };

  /**
   * Check a field path against the form. Returns an error string or null.
   * Allowed: created, modified, owner, _id, and data.<component path> optionally followed by
   * `._id` (a reference) .
   */
  const checkField = (field, catalog) => {
    if (TOP_LEVEL_FIELDS.includes(field)) {
      return null;
    }
    if (!/^data\.[A-Za-z0-9_\-.]+$/.test(field)) {
      return `${field} is not a field of this form`;
    }
    const path = field.slice('data.'.length).replace(/\._id$/, '');
    const component = catalog.get(path);
    if (!component) {
      return `${field} is not a field of this form`;
    }
    if (component.protected || component.encrypted || component.type === 'password') {
      return `${field} is protected and cannot be reported on`;
    }
    return null;
  };

  /**
   * Parse and check the report request. Returns { spec } or { error }.
   */
  const parseSpec = (query, form) => {
    const catalog = fieldCatalog(form);
    const spec = { groupBy: [], metrics: [], dateBucket: null, unwind: null, limit: DEFAULT_LIMIT };

    spec.groupBy = asList(query.groupBy);
    if (spec.groupBy.length > 3) {
      return { error: 'groupBy takes at most 3 fields' };
    }

    const metricList = asList(query.metric);
    if (!metricList.length) {
      metricList.push('count');
    }
    if (metricList.length > 6) {
      return { error: 'at most 6 metrics' };
    }
    for (const metric of metricList) {
      if (metric === 'count') {
        spec.metrics.push({ op: 'count', name: 'count' });
        continue;
      }
      const [op, field] = metric.split(':');
      if (!METRIC_OPS.includes(op) || !field) {
        return { error: `metric must be count or ${METRIC_OPS.join('|')}:<field>` };
      }
      spec.metrics.push({ op, field, name: `${op}:${field}` });
    }

    if (query.dateBucket) {
      const [field, unit] = String(query.dateBucket).split(':');
      if (!DATE_UNITS[unit]) {
        return { error: `dateBucket unit must be one of ${Object.keys(DATE_UNITS).join(', ')}` };
      }
      spec.dateBucket = { field, unit };
    }

    if (query.unwind) {
      const unwind = String(query.unwind).replace(/^data\./, '');
      const component = catalog.get(unwind);
      if (!component || !['datagrid', 'editgrid'].includes(component.type)) {
        return { error: `unwind must name a grid of this form` };
      }
      spec.unwind = unwind;
    }

    if (query.limit !== undefined) {
      const limit = parseInt(query.limit, 10);
      if (!(limit > 0)) {
        return { error: 'limit must be a positive number' };
      }
      spec.limit = Math.min(limit, MAX_LIMIT);
    }

    const fields = [
      ...spec.groupBy,
      ...spec.metrics.filter((metric) => metric.field).map((metric) => metric.field),
      ...(spec.dateBucket ? [spec.dateBucket.field] : []),
    ];
    for (const field of fields) {
      const error = checkField(field, catalog);
      if (error) {
        return { error };
      }
    }
    return { spec, catalog };
  };

  const bucketExpression = ({ field, unit }) => {
    const [format, length] = DATE_UNITS[unit];
    if (field === 'created' || field === 'modified') {
      return { $dateToString: { format, date: `$${field}` } };
    }
    // Date components store ISO strings; the leading characters are the bucket.
    return { $substrCP: [{ $ifNull: [`$${field}`, ''] }, 0, length] };
  };

  const buildPipeline = (spec, match) => {
    const pipeline = [{ $match: match }];
    if (spec.unwind) {
      pipeline.push({ $unwind: `$data.${spec.unwind}` });
    }
    const groupId = {};
    spec.groupBy.forEach((field, index) => {
      groupId[`g${index}`] = `$${field}`;
    });
    if (spec.dateBucket) {
      groupId.bucket = bucketExpression(spec.dateBucket);
    }
    const group = { _id: groupId };
    spec.metrics.forEach((metric, index) => {
      group[`m${index}`] =
        metric.op === 'count' ? { $sum: 1 } : { [`$${metric.op}`]: `$${metric.field}` };
    });
    pipeline.push({ $group: group });
    pipeline.push({ $sort: { _id: 1 } });
    pipeline.push({ $limit: spec.limit + 1 });
    return pipeline;
  };

  // Turn grouped ids into plain strings (ObjectIds, dates) for JSON.
  const plainKey = (value) => {
    if (value === null || value === undefined) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'object' && value._bsontype === 'ObjectId') {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return value.map(plainKey);
    }
    return value;
  };

  router.get('/form/:formId/report', async (req, res) => {
    const log = req.log.child({ module: 'formio:report' });
    const started = Date.now();
    try {
      const form = await router.formio.cache.loadCurrentForm(req);
      if (!form) {
        return res.status(404).send('Form not found');
      }

      const reportQuery = _.pick(req.query, REPORT_PARAMS);
      req.query = _.omit(req.query, REPORT_PARAMS);
      const { spec, error } = parseSpec(reportQuery, form);
      if (error) {
        log.debug({ formId: form._id, error }, 'rejected report request');
        return res.status(400).send(error);
      }

      // Totals filtered on a protected field would reveal its values one count at a time.
      const catalog = fieldCatalog(form);
      const protectedFilter = Object.keys(req.query)
        .filter((name) => name.startsWith('data.'))
        .map((name) => name.split('__')[0])
        .find((name) => {
          const error = checkField(name, catalog);
          return error && error.includes('protected');
        });
      if (protectedFilter) {
        return res.status(400).send(`${protectedFilter} is protected and cannot be filtered on`);
      }

      const scope = req.isAdmin ? 'all' : linked.readScope(form, req);
      if (!scope) {
        log.debug({ formId: form._id }, 'report caller cannot read submissions');
        return res.sendStatus(401);
      }

      const match = router.formio.resources.submission.getFindQuery(req, {
        queryFilter: true,
        convertIds: /(^|\.)(_id|form|owner)$/,
      });
      match.form = form._id;
      match.deleted = { $eq: null };
      if (scope === 'own') {
        match.owner = util.ObjectId(req.user._id);
      }
      const pipeline = buildPipeline(spec, hook.alter('submissionQuery', match, req));
      log.debug(
        {
          formId: form._id,
          scope,
          groupBy: spec.groupBy,
          metrics: spec.metrics.map((metric) => metric.name),
          unwind: spec.unwind,
        },
        'running report',
      );
      log.trace({ stages: pipeline.map((stage) => Object.keys(stage)[0]) }, 'report pipeline');

      const groups = await linked.withSubmissionModel(req, form, (model) =>
        model.aggregate(pipeline).option({ maxTimeMS: MAX_TIME_MS }),
      );
      const truncated = groups.length > spec.limit;
      const rows = groups.slice(0, spec.limit).map((group) => {
        const row = { key: {}, values: {} };
        spec.groupBy.forEach((field, index) => {
          row.key[field] = plainKey(group._id[`g${index}`]);
        });
        if (spec.dateBucket) {
          row.key[`${spec.dateBucket.field}:${spec.dateBucket.unit}`] = plainKey(group._id.bucket);
        }
        spec.metrics.forEach((metric, index) => {
          row.values[metric.name] = group[`m${index}`] === undefined ? null : group[`m${index}`];
        });
        return row;
      });

      // Group keys that are links come back with the linked records' data, read with the
      // caller's own access, so the portal can show names instead of ids.
      const records = {};
      for (const field of spec.groupBy) {
        const path = field.replace(/^data\./, '').replace(/\._id$/, '');
        const ref = linked
          .getReferenceComponents(form)
          .find((candidate) => candidate.path === path);
        if (!ref || !field.endsWith('._id')) {
          continue;
        }
        const ids = rows.map((row) => row.key[field]).filter((id) => /^[a-f0-9]{24}$/i.test(id));
        const loaded = await linked.loadRecords(req, ref.formId, ids, log);
        loaded.forEach((record, id) => {
          records[id] = { _id: id, form: ref.formId, data: record.data };
        });
      }

      const ms = Date.now() - started;
      hook.report('observe', () => [
        metrics.REPORT_DURATION,
        ms,
        { groups: rows.length, unwind: Boolean(spec.unwind) },
      ]);
      log.info({ formId: form._id, groups: rows.length, truncated, ms }, 'report served');
      return res.status(200).json({ rows, records, truncated });
    } catch (err) {
      log.error({ err }, 'report failed');
      return res.status(400).send('Report failed');
    }
  });

  return { parseSpec, buildPipeline };
};
