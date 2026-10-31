import { Utils } from '@formio/js';

// Helpers for the data screen and the Reports tab. They turn what an admin picks (columns,
// filters, sort, a grouping) into the query parameters the server already understands, and
// turn linked records back into readable names.

export type Field = {
  path: string;
  label: string;
  type: string;
  /** The id of the resource a Select/Resource field links to. */
  reference?: string;
  /** The grid this field sits in, if any (its rows can be reported one per line). */
  grid?: string;
  isGrid?: boolean;
  tableView: boolean;
};

export type FilterOperator = 'eq' | 'ne' | 'contains' | 'gt' | 'lt';
export type Filter = { field: string; op: FilterOperator; value: string };
export type Sort = { field: string; desc: boolean } | null;

export type SavedView = {
  name: string;
  columns?: string[];
  conditions?: Filter[];
  sort?: Sort;
  /** Server-side filters (query parameters), also used by export. */
  filters?: Record<string, string>;
  expand?: string[];
  unwind?: string;
};

const GRID_TYPES = ['datagrid', 'editgrid'];
// Layout and non-data components never hold a value worth showing.
const SKIP_TYPES = [
  'button',
  'password',
  'htmlelement',
  'content',
  'panel',
  'fieldset',
  'columns',
  'column',
  'table',
  'tabs',
  'well',
];

/**
 * Every input field in a form, with its data path.
 */
export const getFields = (components: unknown[]): Field[] => {
  const fields: Field[] = [];
  const grids: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Utils.eachComponent(
    components as any,
    (component: any, path: string) => {
      if (component.input === false || !component.key || SKIP_TYPES.includes(component.type)) {
        return;
      }
      const isGrid = GRID_TYPES.includes(component.type);
      if (isGrid) {
        grids.push(path);
      }
      const grid = grids.find((gridPath) => path.startsWith(`${gridPath}.`));
      const reference =
        component.type === 'select' && component.dataSrc === 'resource'
          ? component.data?.resource
          : component.type === 'resource'
            ? component.resource
            : undefined;
      fields.push({
        path,
        label: component.label || component.key,
        type: component.type,
        reference,
        grid,
        isGrid,
        tableView:
          !Object.prototype.hasOwnProperty.call(component, 'tableView') || component.tableView,
      });
    },
    true,
  );
  return fields;
};

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Filters and sort as submission index query parameters (`data.status=open`,
 * `data.total__gt=10`, `sort=-created`).
 */
export const buildQuery = (filters: Filter[], sort: Sort): Record<string, string> => {
  const query: Record<string, string> = {};
  filters.forEach(({ field, op, value }) => {
    if (!field || value === '') {
      return;
    }
    const name = field === 'created' || field === 'modified' ? field : `data.${field}`;
    switch (op) {
      case 'eq':
        query[name] = value;
        break;
      case 'ne':
        query[`${name}__ne`] = value;
        break;
      case 'contains':
        query[`${name}__regex`] = `/${escapeRegex(value)}/i`;
        break;
      case 'gt':
        query[`${name}__gt`] = value;
        break;
      case 'lt':
        query[`${name}__lt`] = value;
        break;
    }
  });
  if (sort?.field) {
    const name =
      sort.field === 'created' || sort.field === 'modified' ? sort.field : `data.${sort.field}`;
    query.sort = `${sort.desc ? '-' : ''}${name}`;
  }
  return query;
};

type LinkedRecord = { _id?: string; data?: Record<string, unknown> };

const isLinkedRecord = (value: unknown): value is LinkedRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value) && '_id' in value;

/**
 * A readable name for a linked record: its name or title field, else its first text value,
 * else its id.
 */
export const recordLabel = (record: LinkedRecord | undefined): string => {
  if (!record) {
    return '';
  }
  const data = record.data || {};
  for (const key of ['name', 'title', 'label', 'fullName', 'email']) {
    if (typeof data[key] === 'string' && data[key]) {
      return data[key] as string;
    }
  }
  const text = Object.values(data).find((value) => typeof value === 'string' && value);
  return (text as string) || record._id || '';
};

/**
 * A cell's text: linked records by name, lists joined, objects as JSON.
 */
export const cellText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(cellText).filter(Boolean).join(', ');
  }
  if (isLinkedRecord(value)) {
    return recordLabel(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
};

export type ReportSpec = {
  groupBy: string;
  metric: 'count' | 'sum' | 'avg' | 'min' | 'max';
  metricField: string;
  dateBucket: '' | 'day' | 'month' | 'year';
  unwind: string;
};

/**
 * The report request as query parameters for GET /form/:id/report.
 */
export const buildReportQuery = (spec: ReportSpec, fields: Field[]): URLSearchParams => {
  const params = new URLSearchParams();
  const groupField = fields.find((field) => field.path === spec.groupBy);
  if (spec.groupBy) {
    params.append(
      'groupBy',
      groupField?.reference ? `data.${spec.groupBy}._id` : `data.${spec.groupBy}`,
    );
  }
  const metricName = spec.metric === 'count' ? 'count' : `${spec.metric}:data.${spec.metricField}`;
  params.append('metric', metricName);
  if (spec.dateBucket) {
    params.append('dateBucket', `created:${spec.dateBucket}`);
  }
  // A field inside a grid is reported one row per line of that grid.
  const metricField = fields.find((field) => field.path === spec.metricField);
  const unwind =
    spec.unwind || (spec.metric !== 'count' && metricField?.grid) || groupField?.grid || '';
  if (unwind) {
    params.append('unwind', unwind);
  }
  return params;
};

export type ReportRow = { key: Record<string, unknown>; values: Record<string, number | null> };
export type ReportResult = {
  rows: ReportRow[];
  records: Record<string, LinkedRecord>;
  truncated: boolean;
};

/**
 * One label and one value per report row, ready for a chart or a table.
 */
export const reportSeries = (result: ReportResult): { label: string; value: number }[] =>
  result.rows.map((row) => {
    const label = Object.values(row.key)
      .map((key) => {
        if (key === null || key === undefined || key === '') {
          return '(none)';
        }
        const record = typeof key === 'string' ? result.records[key] : undefined;
        return record ? recordLabel(record) : cellText(key);
      })
      .join(' · ');
    const value = Object.values(row.values)[0];
    return { label: label || 'All', value: typeof value === 'number' ? value : 0 };
  });

/**
 * Report rows as CSV text.
 */
export const reportCsv = (series: { label: string; value: number }[], valueName: string) => {
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  return [
    [quote('Group'), quote(valueName)].join(','),
    ...series.map(({ label, value }) => [quote(label), String(value)].join(',')),
  ].join('\n');
};
