import { describe, expect, test } from 'vitest';
import {
  buildQuery,
  buildReportQuery,
  cellText,
  getFields,
  recordLabel,
  reportCsv,
  reportSeries,
} from '../src/utils/dataView';

const components = [
  { type: 'textfield', key: 'status', label: 'Status', input: true },
  {
    type: 'select',
    key: 'customer',
    label: 'Customer',
    input: true,
    dataSrc: 'resource',
    data: { resource: 'customers' },
  },
  {
    type: 'datagrid',
    key: 'lines',
    label: 'Lines',
    input: true,
    components: [{ type: 'number', key: 'price', label: 'Price', input: true }],
  },
  { type: 'button', key: 'submit', label: 'Submit', input: true },
];

describe('data view helpers', () => {
  test('lists input fields with paths, links and grids', () => {
    const fields = getFields(components);
    expect(fields.map((field) => [field.path, field.reference, field.grid, field.isGrid])).toEqual([
      ['status', undefined, undefined, false],
      ['customer', 'customers', undefined, false],
      ['lines', undefined, undefined, true],
      ['lines.price', undefined, 'lines', false],
    ]);
  });

  test('builds submission filters and sort', () => {
    expect(
      buildQuery(
        [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'status', op: 'contains', value: 'a.b' },
          { field: 'lines.price', op: 'gt', value: '10' },
          { field: 'created', op: 'lt', value: '2026-01-01' },
          { field: '', op: 'eq', value: 'ignored' },
        ],
        { field: 'status', desc: true },
      ),
    ).toEqual({
      'data.status': 'open',
      'data.status__regex': '/a\\.b/i',
      'data.lines.price__gt': '10',
      created__lt: '2026-01-01',
      sort: '-data.status',
    });
  });

  test('names linked records', () => {
    expect(recordLabel({ _id: '1', data: { name: 'Ada' } })).toBe('Ada');
    expect(recordLabel({ _id: '1', data: { code: 'X1' } })).toBe('X1');
    expect(recordLabel({ _id: '1', data: {} })).toBe('1');
    expect(
      cellText([
        { _id: '1', data: { title: 'Cake' } },
        { _id: '2', data: { title: 'Bread' } },
      ]),
    ).toBe('Cake, Bread');
    expect(cellText(12)).toBe('12');
    expect(cellText(null)).toBe('');
  });

  test('builds report requests, reading grid fields one row per line', () => {
    const fields = getFields(components);
    const params = buildReportQuery(
      {
        groupBy: 'customer',
        metric: 'sum',
        metricField: 'lines.price',
        dateBucket: 'month',
        unwind: '',
      },
      fields,
    );
    expect(params.toString()).toBe(
      'groupBy=data.customer._id&metric=sum%3Adata.lines.price&dateBucket=created%3Amonth&unwind=lines',
    );
    expect(
      buildReportQuery(
        { groupBy: '', metric: 'count', metricField: '', dateBucket: '', unwind: '' },
        fields,
      ).toString(),
    ).toBe('metric=count');
  });

  test('labels report rows with linked record names and writes CSV', () => {
    const series = reportSeries({
      rows: [
        { key: { 'data.customer._id': 'c1' }, values: { count: 2 } },
        { key: { 'data.customer._id': null }, values: { count: 1 } },
      ],
      records: { c1: { _id: 'c1', data: { name: 'Ada "A"' } } },
      truncated: false,
    });
    expect(series).toEqual([
      { label: 'Ada "A"', value: 2 },
      { label: '(none)', value: 1 },
    ]);
    expect(reportCsv(series, 'Count')).toBe('"Group","Count"\n"Ada ""A""",2\n"(none)",1');
  });
});
