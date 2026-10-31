'use strict';

const ResourceFactory = require('resourcejs');
const Resource = ResourceFactory.Resource;
const _ = require('lodash');

module.exports = (router) => {
  const hook = require('../util/hook')(router.formio);
  const handlers = router.formio.middleware.submissionHandler;
  const hiddenFields = ['deleted', '__v', 'machineName'];
  const linked = require('../util/linkedRecords')(router);
  const linkedRows = require('../util/linkedRows')(router);

  // `?expand=customer,lines.product` replaces references at those paths with the live
  // records they point to (read through the caller's own access). Taken off the query
  // before resourcejs builds a filter from it.
  const takeExpandParam = (req, res, next) => {
    req.expandPaths = linked.takeExpandParam(req);
    next();
  };
  const expandReferences = async (req, res, next) => {
    const paths = req.expandPaths;
    // Sub-requests clone the parent request; only the outermost request expands.
    if (!paths || !paths.length || req.childRequests || !_.get(res, 'resource.item')) {
      return next();
    }
    const log = req.log.child({ module: 'formio:expand' });
    const started = Date.now();
    try {
      const form = await router.formio.cache.loadCurrentForm(req);
      const items = [].concat(res.resource.item);
      log.debug({ formId: form._id, paths, count: items.length }, 'expanding references');
      await linked.expandSubmissions(req, form, items, paths, log);
      log.debug({ formId: form._id, ms: Date.now() - started }, 'expanded references');
      return next();
    } catch (err) {
      log.error({ err }, 'failed to expand references');
      return next(err);
    }
  };

  // Manually update the handlers, to add additional middleware.
  handlers.beforePost = [
    router.formio.middleware.filterIdCreate,
    router.formio.middleware.permissionHandler,
    router.formio.middleware.filterMongooseExists({ field: 'deleted', isNull: true }),
    router.formio.middleware.allowTimestampOverride,
    router.formio.middleware.bootstrapEntityOwner,
    router.formio.middleware.bootstrapSubmissionAccess,
    router.formio.middleware.addSubmissionResourceAccess,
    router.formio.middleware.condenseSubmissionPermissionTypes,
    handlers.beforePost,
  ];
  handlers.afterPost = [
    handlers.afterPost,
    router.formio.middleware.filterResourcejsResponse(hiddenFields),
    router.formio.middleware.filterProtectedFields('create', (req) =>
      router.formio.cache.getCurrentFormId(req),
    ),
  ];
  handlers.beforeGet = [
    takeExpandParam,
    router.formio.middleware.permissionHandler,
    router.formio.middleware.filterMongooseExists({ field: 'deleted', isNull: true }),
    handlers.beforeGet,
  ];
  handlers.afterGet = [
    handlers.afterGet,
    router.formio.middleware.filterResourcejsResponse(hiddenFields),
    router.formio.middleware.filterProtectedFields('get', (req) =>
      router.formio.cache.getCurrentFormId(req),
    ),
    async (req, res, next) => {
      try {
        const currentForm = await router.formio.cache.loadCurrentForm(req);
        await hook.alter('getSubmissionRevisionModel', router.formio, req, currentForm, false);
        return next();
      } catch (err) {
        return next(err);
      }
    },
    router.formio.middleware.submissionRevisionLoader,
    expandReferences,
  ];
  handlers.beforePut = [
    router.formio.middleware.permissionHandler,
    router.formio.middleware.submissionApplyPatch,
    router.formio.middleware.filterMongooseExists({ field: 'deleted', isNull: true }),
    router.formio.middleware.allowTimestampOverride,
    router.formio.middleware.bootstrapEntityOwner,
    router.formio.middleware.bootstrapSubmissionAccess,
    router.formio.middleware.addSubmissionResourceAccess,
    router.formio.middleware.condenseSubmissionPermissionTypes,
    router.formio.middleware.loadPreviousSubmission,
    handlers.beforePut,
  ];
  handlers.afterPut = [
    handlers.afterPut,
    router.formio.middleware.filterResourcejsResponse(hiddenFields),
    router.formio.middleware.filterProtectedFields('update', (req) =>
      router.formio.cache.getCurrentFormId(req),
    ),
  ];
  handlers.beforeIndex = [
    takeExpandParam,
    (req, res, next) => {
      // If we leave list in query it will interfere with the find query.
      if (req.query.list) {
        req.filterIndex = true;
        delete req.query.list;
      }

      if (req.query.full) {
        req.full = true;
        delete req.query.full;
      }

      next();
    },
    router.formio.middleware.permissionHandler,
    router.formio.middleware.setFilterQueryTypes,
    router.formio.middleware.filterMongooseExists({
      field: 'deleted',
      isNull: true,
      resource: 'submission',
    }),
    router.formio.middleware.ownerFilter,
    router.formio.middleware.submissionResourceAccessFilter,
    router.formio.middleware.submissionFieldMatchAccessFilter,
    handlers.beforeIndex,
  ];
  handlers.afterIndex = [
    handlers.afterIndex,
    router.formio.middleware.filterResourcejsResponse(hiddenFields),
    router.formio.middleware.filterProtectedFields('index', (req) =>
      router.formio.cache.getCurrentFormId(req),
    ),
    router.formio.middleware.filterIndex(['data']),
    expandReferences,
  ];
  handlers.beforeDelete = [
    router.formio.middleware.permissionHandler,
    router.formio.middleware.filterMongooseExists({ field: 'deleted', isNull: true }),
    handlers.beforeDelete,
    router.formio.middleware.loadPreviousSubmission,
    router.formio.middleware.deleteSubmissionHandler,
  ];
  handlers.afterDelete = [
    handlers.afterDelete,
    router.formio.middleware.filterResourcejsResponse(hiddenFields),
    router.formio.middleware.filterProtectedFields('delete', (req) =>
      router.formio.cache.getCurrentFormId(req),
    ),
  ];

  // Which forms link to this submission, with counts the caller is allowed to see. The
  // global permissionHandler has already required read access to the submission itself.
  router.get('/form/:formId/submission/:submissionId/related', async (req, res) => {
    const log = req.log.child({ module: 'formio:related' });
    try {
      const submission = await router.formio.cache.loadSubmission(
        req,
        req.params.formId,
        req.params.submissionId,
      );
      if (!submission) {
        log.debug({ submissionId: req.params.submissionId }, 'related: submission not found');
        return res.status(404).send('Not found');
      }
      const started = Date.now();
      const related = await linked.findRelated(
        req,
        req.params.formId,
        req.params.submissionId,
        log,
      );
      log.debug(
        { submissionId: req.params.submissionId, forms: related.length, ms: Date.now() - started },
        'related records counted',
      );
      return res.status(200).json(related);
    } catch (err) {
      log.error({ err }, 'failed to find related records');
      return res.status(500).send('Internal server error');
    }
  });

  // Linked rows: compute the rows of every grid with a `linkedRows` setting from the records
  // currently picked in `data`. `changed` (optional) limits it to grids fed by that field.
  // params.js maps this route to the submission collection, so it needs create access.
  router.post('/form/:formId/prefill', async (req, res) => {
    const log = req.log.child({ module: 'formio:linkedRows' });
    try {
      const form = await router.formio.cache.loadCurrentForm(req);
      if (!form) {
        return res.status(404).send('Form not found');
      }
      const data = _.isPlainObject(_.get(req.body, 'data')) ? req.body.data : {};
      const changed = typeof req.body.changed === 'string' ? req.body.changed : null;
      const started = Date.now();
      log.debug({ formId: form._id, changed }, 'prefilling linked rows');
      const rows = await linkedRows.prefill(req, form, data, changed, log);
      log.debug(
        { formId: form._id, grids: Object.keys(rows).length, ms: Date.now() - started },
        'prefilled linked rows',
      );
      return res.status(200).json({ data: rows });
    } catch (err) {
      log.error({ err }, 'failed to prefill linked rows');
      return res.status(400).send(err.message);
    }
  });

  // Register an exists endpoint to see if a submission exists.
  router.get(
    '/form/:formId/exists',
    async (req, res, next) => {
      const { ignoreCase = false } = req.query;
      // We need to strip the ignoreCase query out so resourcejs does not use it as a filter
      if (ignoreCase) {
        delete req.query['ignoreCase'];
      }
      // First load the form.
      try {
        const form = await router.formio.cache.loadCurrentForm(req);
        await hook.alter('getSubmissionModel', router.formio, req, form, false);
        // Get the find query for this item.
        const query = router.formio.resources.submission.getFindQuery(req);
        if (_.isEmpty(query)) {
          return res.status(400).send('Invalid query');
        }

        query.form = form._id;
        query.deleted = { $eq: null };
        const submissionModel = req.submissionModel || router.formio.resources.submission.model;

        // Query the submissions for this submission.
        const submission = await submissionModel.findOne(
          hook.alter('submissionQuery', query, req),
          null,
          ignoreCase && router.formio.mongoFeatures.collation
            ? { collation: { locale: 'en', strength: 2 } }
            : {},
        );
        // By default check permissions to access the endpoint.
        const withoutPermissions = _.get(form, 'settings.allowExistsEndpoint', false);

        if (withoutPermissions) {
          // Return not found.
          if (!submission || !submission._id) {
            return res.status(404).send('Not found');
          }
          // Send only the id as a response if the submission exists.
          return res.status(200).json({
            _id: submission._id.toString(),
          });
        }

        if (!submission || !submission._id) {
          req.log.debug(
            { module: 'formio:exists' },
            `No submission matched on form ${form._id}; deferring the response to permissionHandler.`,
          );
          req.submissionNotFound = true;
          req.checkSubmissionAccess = true;
        } else {
          req.subId = submission._id.toString();
        }
        req.permissionsChecked = false;
        return next();
      } catch (ignoreErr) {
        // Don't expose error details to clients
        return res.status(500).send('Internal server error');
      }
    },
    router.formio.middleware.permissionHandler,
    (req, res, _next) => {
      if (req.submissionNotFound) {
        return res.status(404).send('Not found');
      }
      return res.status(200).json({
        _id: req.subId,
      });
    },
  );

  router.delete(
    '/form/:formId/submission',
    ...handlers.beforeDelete.filter((_, idx) => idx !== 1),
    ...handlers.afterDelete,
    (req, res) => {
      return res.resource
        ? res.status(res.resource.status).json(res.resource.item)
        : res.sendStatus(400);
    },
  );

  class SubmissionResource extends Resource {
    patch(options) {
      options = Resource.getMethodOptions('put', options);
      this.methods.push('patch');
      this._register(
        'patch',
        `${this.route}/:${this.name}Id`,
        (req, res, next) => {
          // Store the internal method for response manipulation.
          req.__rMethod = 'patch';

          if (req.skipResource) {
            return next();
          }

          const update = _.omit(req.body, ['_id', '__v']);
          update.modified = new Date();

          options.hooks.put.before.call(this, req, res, update, () => {
            const model = req.model || router.formio.resources.submission.model;
            model
              .findOneAndUpdate(
                { _id: req.params[`${this.name}Id`] },
                { $set: update },
                { new: true },
              )
              .then((item) => {
                if (!item) {
                  return Resource.setResponse(res, { status: 404 }, next);
                }

                return options.hooks.put.after.call(
                  this,
                  req,
                  res,
                  item,
                  Resource.setResponse.bind(Resource, res, { status: 200, item }, next),
                );
              })
              .catch((err) => {
                return Resource.setResponse(res, { status: 400, error: err }, next);
              });
          });
        },
        Resource.respond,
        options,
      );
      return this;
    }
  }

  // Since we are handling patching before we get to resourcejs, make it work like put.

  const MySubmissionResource = hook.alter('SubmissionResource', SubmissionResource, null);

  const submissionResource = new MySubmissionResource(
    router,
    '/form/:formId',
    'submission',
    router.formio.mongoose.model('submission'),
    {
      convertIds: /(^|\.)(_id|form|owner)$/,
    },
  ).rest(
    hook.alter('submissionRoutes', {
      ...handlers,
      hooks: {
        put: {
          before(req, res, item, next) {
            if (item.data && item.markModified) {
              item.markModified('data');
            }

            return next();
          },
        },
      },
    }),
  );

  _.each(handlers, (handler) => {
    _.each(handler, (fn, index) => {
      handler[index] = fn.bind(submissionResource);
    });
  });
  submissionResource.handlers = handlers;
  return submissionResource;
};
