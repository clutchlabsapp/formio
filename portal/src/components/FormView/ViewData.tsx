import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SubmissionTable,
  useFormioContext,
  SubmissionTableProps,
  Form,
  FormProps,
} from '@formio/react';
import { Utils } from '@formio/js';
import {
  buildQuery,
  cellText,
  Field,
  Filter,
  FilterOperator,
  getFields,
  SavedView,
  Sort,
} from '../../utils/dataView';

const components: SubmissionTableProps['components'] = {
  Container: ({ children }) => <div className="table-wrap">{children}</div>,
  TableContainer: ({ children }) => <div className="table remember-focus-table">{children}</div>,
  TableHeadContainer: ({ children }) => <div>{children}</div>,
  TableHeaderRowContainer: ({ children }) => <div className="trow heading">{children}</div>,
  TableHeadCell: ({ children }) => <div className="tcol">{children}</div>,
  TableBodyRowContainer: ({ children, onClick }) => (
    <div className="trow entry" onClick={onClick}>
      {children}
    </div>
  ),
  TableBodyContainer: ({ children }) => <div>{children}</div>,
  TableCell: ({ children }) => <div className="tcol">{children}</div>,
  PaginationContainer: ({ children }) => (
    <div className="table-pagination">
      <div className="table-pagination-controls">{children}</div>
    </div>
  ),
  PaginationButton: ({ children, isActive, onClick, disabled }) => (
    <a
      className={`pagination-btn${isActive ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onClick={onClick}
    >
      {children}
    </a>
  ),
};

type Submission = NonNullable<FormProps['submission']> & { _id: string };
type FormDefinition = {
  _id: string;
  components: unknown[];
  settings?: { views?: SavedView[] } & Record<string, unknown>;
} & Record<string, unknown>;
type Related = { form: string; title: string; field: string; count: number; type: string };

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'is more than' },
  { value: 'lt', label: 'is less than' },
];

const renderCell: SubmissionTableProps['renderCell'] = (value) => cellText(value);

export const ViewData = ({ formId }: { formId: string }) => {
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [form, setForm] = useState<FormDefinition | null>(null);
  const [columns, setColumns] = useState<string[] | undefined>();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<Sort>(null);
  const [viewName, setViewName] = useState('');
  const [showColumns, setShowColumns] = useState(false);
  const [related, setRelated] = useState<Related[]>([]);
  const [message, setMessage] = useState('');
  const { Formio, token } = useFormioContext();
  const base = Formio.projectUrl || Formio.baseUrl;

  useEffect(() => {
    const formio = new Formio(`${base}/form/${formId}`);
    formio
      .loadForm()
      .then((loaded: FormDefinition) => setForm(loaded))
      .catch((err: unknown) => console.log('Error while loading the form:', err));
  }, [Formio, base, formId]);

  const fields: Field[] = useMemo(() => (form ? getFields(form.components) : []), [form]);
  const columnFields = fields.filter((field) => !field.grid);
  const views: SavedView[] = form?.settings?.views || [];
  const query = useMemo(() => buildQuery(filters, sort), [filters, sort]);
  const visibleColumns =
    columns || columnFields.filter((field) => field.tableView && !field.isGrid).map((f) => f.path);

  const applyView = (name: string) => {
    setViewName(name);
    const view = views.find((candidate) => candidate.name === name);
    setColumns(view?.columns);
    setFilters(view?.conditions || []);
    setSort(view?.sort || null);
  };

  const saveView = async () => {
    if (!form) {
      return;
    }
    const name = window.prompt('Name this view', viewName || '');
    if (!name) {
      return;
    }
    const view: SavedView = {
      name,
      columns: visibleColumns,
      conditions: filters,
      sort,
      filters: buildQuery(filters, null),
    };
    const nextViews = [...views.filter((candidate) => candidate.name !== name), view];
    try {
      const formio = new Formio(`${base}/form/${formId}`);
      const saved = await formio.saveForm({
        ...form,
        settings: { ...(form.settings || {}), views: nextViews },
      });
      setForm(saved);
      setViewName(name);
      setMessage(`Saved view "${name}".`);
    } catch (err) {
      setMessage('Could not save the view.');
      console.log('Error while saving the view:', err);
    }
  };

  const loadRelated = useCallback(
    async (id: string) => {
      try {
        const result = await Formio.makeRequest(
          null,
          'related',
          `${base}/form/${formId}/submission/${id}/related`,
          'GET',
        );
        setRelated(Array.isArray(result) ? result : []);
      } catch (err) {
        setRelated([]);
        console.log('Error while loading related records:', err);
      }
    },
    [Formio, base, formId],
  );

  const handleSubmissionRowClick = async (id: string) => {
    const formio = new Formio(`${base}/form/${formId}/submission/${id}`);
    try {
      const loaded = await formio.loadSubmission();
      setSubmission(loaded);
      loadRelated(id);
    } catch (err) {
      console.log('Error while loading submission:', err);
    }
  };

  const handleDeleteSubmission = async () => {
    if (!submission) {
      return;
    }
    const formio = new Formio(`${base}/form/${formId}/submission/${submission._id}`);
    try {
      await formio.deleteSubmission();
      setSubmission(null);
    } catch (err) {
      console.log('Error while deleting submission:', err);
    }
  };

  const handleExport = async (exportType: 'json' | 'csv') => {
    const filename = `${formId}-submissions.${exportType}`;
    try {
      const params = new URLSearchParams({
        format: exportType,
        timezone: Utils.currentTimezone(),
        ...(exportType === 'csv' ? { view: 'formatted' } : {}),
        ...buildQuery(filters, null),
      });
      // TODO: this should use the SDK (if applicable) and not naked fetch
      const response = await fetch(`/form/${formId}/export?${params.toString()}`, {
        headers: { 'x-jwt-token': token },
      });
      if (!response.ok) {
        throw new Error(`Error fetching data: ${response.statusText}`);
      }
      const blob =
        exportType === 'json'
          ? new Blob([JSON.stringify(await response.json(), null, 2)], {
              type: 'application/json',
            })
          : await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // Append the link to the document body (necessary for Firefox)
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading the export:', error);
    }
  };

  const updateFilter = (index: number, change: Partial<Filter>) =>
    setFilters((current) =>
      current.map((filter, i) => (i === index ? { ...filter, ...change } : filter)),
    );

  const toggleColumn = (path: string) => {
    const next = visibleColumns.includes(path)
      ? visibleColumns.filter((column) => column !== path)
      : [...visibleColumns, path];
    setColumns(next);
  };

  return (
    <div className="panel view-data active">
      <div className="button-wrap export">
        <button
          className="button export-json small withiconright"
          onClick={() => handleExport('json')}
        >
          Export JSON <i className="ri-download-2-line"></i>
        </button>
        <button
          className="button export-csv small withiconright"
          onClick={() => handleExport('csv')}
        >
          Export CSV <i className="ri-download-2-line"></i>
        </button>
        <button className="button commercial pdf small withicon">
          <img src="icon-formio-small.svg" alt="Form.io Icon" />
          Print To PDF
        </button>
      </div>

      <div className="data-toolbar" aria-label="Data view controls">
        <label className="data-toolbar-item">
          View{' '}
          <select
            aria-label="Saved view"
            value={viewName}
            onChange={(event) => applyView(event.target.value)}
          >
            <option value="">All submissions</option>
            {views.map((view) => (
              <option key={view.name} value={view.name}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button small" onClick={() => setShowColumns((open) => !open)}>
          Columns
        </button>
        <label className="data-toolbar-item">
          Sort by{' '}
          <select
            aria-label="Sort by"
            value={sort?.field || ''}
            onChange={(event) =>
              setSort(event.target.value ? { field: event.target.value, desc: !!sort?.desc } : null)
            }
          >
            <option value="">Newest first</option>
            <option value="created">Created</option>
            {columnFields
              .filter((field) => !field.isGrid)
              .map((field) => (
                <option key={field.path} value={field.path}>
                  {field.label}
                </option>
              ))}
          </select>
          {sort && (
            <button
              className="button small"
              aria-label="Reverse sort order"
              onClick={() => setSort({ ...sort, desc: !sort.desc })}
            >
              {sort.desc ? 'Descending' : 'Ascending'}
            </button>
          )}
        </label>
        <button
          className="button small"
          onClick={() => setFilters((current) => [...current, { field: '', op: 'eq', value: '' }])}
        >
          Add filter
        </button>
        <button className="button small" onClick={saveView}>
          Save view
        </button>
        {message && (
          <span className="helptext" role="status">
            {message}
          </span>
        )}
      </div>

      {showColumns && (
        <fieldset className="data-columns">
          <legend>Columns</legend>
          {columnFields
            .filter((field) => !field.isGrid)
            .map((field) => (
              <label key={field.path}>
                <input
                  type="checkbox"
                  checked={visibleColumns.includes(field.path)}
                  onChange={() => toggleColumn(field.path)}
                />{' '}
                {field.label}
              </label>
            ))}
        </fieldset>
      )}

      {filters.map((filter, index) => (
        <div className="data-filter" key={index}>
          <select
            aria-label="Filter field"
            value={filter.field}
            onChange={(event) => updateFilter(index, { field: event.target.value })}
          >
            <option value="">Choose a field</option>
            <option value="created">Created</option>
            {columnFields
              .filter((field) => !field.isGrid && !field.reference)
              .map((field) => (
                <option key={field.path} value={field.path}>
                  {field.label}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter operator"
            value={filter.op}
            onChange={(event) => updateFilter(index, { op: event.target.value as FilterOperator })}
          >
            {OPERATORS.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter value"
            value={filter.value}
            onChange={(event) => updateFilter(index, { value: event.target.value })}
          />
          <button
            className="button small"
            aria-label="Remove filter"
            onClick={() => setFilters((current) => current.filter((_, i) => i !== index))}
          >
            <i className="ri-close-line"></i>
          </button>
        </div>
      ))}

      {submission ? (
        <>
          <SubmissionTable
            submissions={[submission]}
            formId={formId}
            limit={10}
            columns={visibleColumns}
            renderCell={renderCell}
            components={{
              ...components,
              PaginationButton: ({ children, isActive }) => (
                <a className={`pagination-btn disabled${isActive ? ' active' : ''}`}>{children}</a>
              ),
            }}
          />
          <div className="entry-details-wrap active">
            <div className="entry-details-menu-wrap">
              <button
                className="close-button close-entry-details"
                onClick={() => setSubmission(null)}
              >
                <i className="ri-close-line"></i>
              </button>
              <button className="button pink small open-lightbox" onClick={handleDeleteSubmission}>
                Delete <span className="longword">Submission</span>
              </button>
            </div>
            {related.length > 0 && (
              <div className="entry-related" aria-label="Related records">
                <div className="strong">Linked from</div>
                <ul>
                  {related.map((item) => (
                    <li key={`${item.form}-${item.field}`}>
                      <a
                        href={`#/${item.type === 'resource' ? 'resource' : 'form'}/${item.form}/view`}
                      >
                        {item.title}
                      </a>{' '}
                      ({item.field}): {item.count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="entry-details-content edit-submission active">
              <Form
                submission={submission}
                src={`/form/${formId}`}
                onSubmitDone={() => setSubmission(null)}
              />
            </div>
          </div>
        </>
      ) : (
        <SubmissionTable
          onSubmissionClick={handleSubmissionRowClick}
          limit={10}
          formId={formId}
          submissionQuery={query}
          columns={visibleColumns}
          renderCell={renderCell}
          components={components}
        />
      )}
    </div>
  );
};
