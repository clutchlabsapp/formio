'use strict';

const _ = require('lodash');
const util = require('./util');

// Shared plumbing for everything that follows a link from one submission to another:
// `?expand=` on reads, the `related` endpoint, linked-rows prefill/push and reports.
//
// A "reference component" is a Select (dataSrc resource) or Resource component. Its value is
// `{ _id }` (reference: true) or a full submission copy; either way `_id` names the record.
// Paths are data paths without row indexes (`lines.product`); a path that crosses a grid
// visits every row.

// The deepest chain `?expand=` will follow (`customer.defaultProducts` is two hops).
const MAX_EXPAND_DEPTH = 2;

// Never returned on a submission read (matches SubmissionResource's hiddenFields).
const HIDDEN_FIELDS = ['deleted', '__v', 'machineName'];

const getReferencedFormId = (component) => {
  if (!component) {
    return null;
  }
  if (component.type === 'select' && component.dataSrc === 'resource') {
    return _.get(component, 'data.resource') || null;
  }
  if (component.type === 'resource' && component.resource) {
    return component.resource;
  }
  return null;
};

/**
 * Every reference component in a form, with its data path.
 *
 * @param form
 * @return {Array<{ path: string, component: object, formId: string }>}
 */
const getReferenceComponents = (form) => {
  const refs = [];
  if (!form || !Array.isArray(form.components)) {
    return refs;
  }
  util.FormioUtils.eachComponent(
    form.components,
    (component, path) => {
      const formId = getReferencedFormId(component);
      if (formId && path) {
        refs.push({ path, component, formId: formId.toString() });
      }
    },
    true,
  );
  return refs;
};

/**
 * Find the reference component a dotted path starts with. Returns the match and the segments
 * left over (the hops to follow inside the referenced form).
 */
const matchReferencePath = (refs, segments) => {
  for (let length = segments.length; length > 0; length--) {
    const path = segments.slice(0, length).join('.');
    const ref = refs.find((candidate) => candidate.path === path);
    if (ref) {
      return { ref, rest: segments.slice(length) };
    }
  }
  return null;
};

/**
 * Visit every value stored at `path` inside `data`, crossing arrays (grid rows) on the way.
 * The callback receives the value and a setter that replaces it in place.
 */
const visitPath = (data, path, visit) => {
  const segments = path.split('.');
  const walk = (holder, index) => {
    if (Array.isArray(holder)) {
      holder.forEach((row) => walk(row, index));
      return;
    }
    if (!holder || typeof holder !== 'object') {
      return;
    }
    const key = segments[index];
    if (index === segments.length - 1) {
      if (holder[key] !== undefined && holder[key] !== null) {
        visit(holder[key], (value) => {
          holder[key] = value;
        });
      }
      return;
    }
    walk(holder[key], index + 1);
  };
  walk(data, 0);
};

// The `_id`s a reference value names: one for a single value, several for `multiple`.
const idsOf = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => item && item._id)
    .map((item) => item._id.toString())
    .filter((id) => /^[a-f0-9]{24}$/i.test(id));
};

module.exports = (router) => {
  const hook = require('./hook')(router.formio);

  /**
   * Load submissions of one form by id. Applies the same gates as the reference `$lookup` on
   * the submission index: the form must match, deleted records are skipped, a caller without
   * read_all sees only records they own (read_own) or none, `submissionQuery` alters apply, and
   * protected fields are removed. Ids the caller cannot read are absent from the result.
   *
   * @return {Promise<Map<string, object>>} id -> submission
   */
  const loadRecords = async (req, formId, ids, log) => {
    const unique = _.uniq(ids);
    const records = new Map();
    if (!unique.length) {
      return records;
    }
    log.trace({ formId, idCount: unique.length }, 'loading linked records');
    const started = Date.now();
    const form = await router.formio.cache.loadForm(req, null, formId);
    const scope = form ? readScope(form, req) : null;
    if (!scope) {
      log.debug({ formId }, 'linked form not readable by caller; leaving references as ids');
      return records;
    }
    const query = {
      _id: { $in: unique.map((id) => util.ObjectId(id)) },
      form: form._id,
      deleted: { $eq: null },
    };
    if (scope === 'own') {
      query.owner = util.ObjectId(req.user._id);
    }
    const items = await withSubmissionModel(req, form, (model) =>
      model.find(hook.alter('submissionQuery', query, req)).lean(),
    );
    util.removeProtectedFields(form, 'get', items);
    items.forEach((item) => {
      records.set(item._id.toString(), _.omit(item, HIDDEN_FIELDS));
    });
    log.trace(
      { formId, requested: unique.length, loaded: records.size, ms: Date.now() - started },
      'loaded linked records',
    );
    return records;
  };

  /**
   * Replace references at each `?expand=` path with the live records they point to, following
   * up to MAX_EXPAND_DEPTH hops. A reference the caller cannot read keeps only its `_id`.
   *
   * @param req
   * @param form The form the submissions belong to.
   * @param submissions Plain submission objects; modified in place.
   * @param paths Dotted paths, e.g. ['customer', 'lines.product.supplier'].
   */
  const expandSubmissions = async (req, form, submissions, paths, log, depth = 0) => {
    if (!submissions.length || !paths.length || depth >= MAX_EXPAND_DEPTH) {
      return;
    }
    const refs = getReferenceComponents(form);

    // Group the requested paths by the reference component they start with, so each
    // component is loaded once however many deeper paths go through it.
    const groups = new Map();
    paths.forEach((path) => {
      const match = matchReferencePath(refs, path.split('.'));
      if (!match) {
        log.debug({ formId: form._id, path }, 'expand path names no reference component');
        return;
      }
      const group = groups.get(match.ref.path) || { ref: match.ref, rest: [] };
      if (match.rest.length) {
        group.rest.push(match.rest.join('.'));
      }
      groups.set(match.ref.path, group);
    });

    for (const { ref, rest } of groups.values()) {
      const ids = [];
      submissions.forEach((submission) =>
        visitPath(submission.data, ref.path, (value) => ids.push(...idsOf(value))),
      );
      const records = await loadRecords(req, ref.formId, ids, log);
      const resolve = (item) => {
        if (!item || !item._id) {
          return item;
        }
        return records.get(item._id.toString()) || { _id: item._id };
      };
      submissions.forEach((submission) =>
        visitPath(submission.data, ref.path, (value, set) =>
          set(Array.isArray(value) ? value.map(resolve) : resolve(value)),
        ),
      );
      log.debug(
        { formId: form._id, path: ref.path, depth, loaded: records.size },
        'expanded references',
      );

      if (rest.length && records.size) {
        const refForm = await router.formio.cache.loadForm(req, null, ref.formId);
        await expandSubmissions(req, refForm, [...records.values()], rest, log, depth + 1);
      }
    }
  };

  /**
   * Parse `?expand=a,b.c` into a clean list of paths. Removes the parameter from the query so
   * the index does not treat it as a filter.
   */
  const takeExpandParam = (req) => {
    const raw = req.query && req.query.expand;
    if (!raw) {
      return [];
    }
    delete req.query.expand;
    return _.uniq(
      (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((path) => String(path).trim())
        .filter((path) => /^[A-Za-z0-9_\-.]+$/.test(path))
        .map((path) => path.replace(/^data\./, '')),
    );
  };

  /**
   * Which of a form's submissions the caller may read: 'all', 'own' or null (none).
   * Mirrors the role checks permissionHandler applies to a submission index.
   */
  const readScope = (form, req) => {
    if (util.checkReferenceReadAccess(form, null, req)) {
      return 'all';
    }
    const ownRoles = [];
    (form.submissionAccess || []).forEach((permission) => {
      if (permission.type === 'read_own') {
        permission.roles.forEach((id) => ownRoles.push(id.toString()));
      }
    });
    const userRoles = req.accessRoles || [];
    if (req.user && req.user._id && _.intersection(ownRoles, userRoles).length) {
      return 'own';
    }
    return null;
  };

  /**
   * Run `fn(submissionModel)` with the model the given form stores its submissions in (the
   * enterprise server can route a form to its own collection).
   */
  const withSubmissionModel = async (req, form, fn) => {
    const previous = req.submissionModel;
    delete req.submissionModel;
    try {
      await hook.alter('getSubmissionModel', router.formio, req, form, false);
      return await fn(req.submissionModel || router.formio.resources.submission.model);
    } finally {
      if (previous) {
        req.submissionModel = previous;
      } else {
        delete req.submissionModel;
      }
    }
  };

  /**
   * Every form with a reference component pointing at `formId`, and how many of its
   * submissions (that the caller may read) point at `submissionId`.
   */
  const findRelated = async (req, formId, submissionId, log) => {
    const forms = await router.formio.resources.form.model
      .find(await hook.alter('formQuery', { deleted: { $eq: null } }, req))
      .select('_id title name path type components submissionAccess settings')
      .lean();
    log.trace({ formCount: forms.length }, 'scanning forms for references');

    const related = [];
    for (const form of forms) {
      const paths = getReferenceComponents(form)
        .filter((ref) => ref.formId === formId.toString())
        .map((ref) => ref.path);
      if (!paths.length) {
        continue;
      }
      const scope = readScope(form, req);
      if (!scope) {
        log.trace({ formId: form._id }, 'skipping referencing form the caller cannot read');
        continue;
      }
      const idMatch = { $in: [util.ObjectId(submissionId), submissionId.toString()] };
      for (const path of paths) {
        const query = {
          form: form._id,
          deleted: { $eq: null },
          [`data.${path}._id`]: idMatch,
        };
        if (scope === 'own') {
          query.owner = util.ObjectId(req.user._id);
        }
        const count = await withSubmissionModel(req, form, (model) =>
          model.countDocuments(hook.alter('submissionQuery', query, req)),
        );
        log.trace({ formId: form._id, path, count }, 'counted referencing submissions');
        if (count) {
          related.push({
            form: form._id.toString(),
            title: form.title,
            name: form.name,
            path: form.path,
            type: form.type,
            field: path,
            count,
          });
        }
      }
    }
    return related;
  };

  return {
    MAX_EXPAND_DEPTH,
    getReferencedFormId,
    getReferenceComponents,
    matchReferencePath,
    visitPath,
    idsOf,
    loadRecords,
    expandSubmissions,
    takeExpandParam,
    readScope,
    withSubmissionModel,
    findRelated,
  };
};
