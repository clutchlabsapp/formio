import { useEffect, useMemo, useState } from 'react';
import { useFormioContext } from '@formio/react';
import {
  buildReportQuery,
  Field,
  getFields,
  ReportResult,
  ReportSpec,
  reportCsv,
  reportSeries,
} from '../../utils/dataView';

// Reports: grouped totals over a form's submissions, from GET /form/:id/report.
// One measure, so one hue and no legend; the title names the measure. A table of the same
// numbers sits beside the chart for exact values and screen readers.

const BAR = '#2a78d6';
const BAR_THICKNESS = 18;
const ROW_HEIGHT = 30;
const LABEL_WIDTH = 160;
const VALUE_GUTTER = 64;
const CHART_WIDTH = 640;

const formatValue = (value: number) =>
  Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const BarChart = ({
  series,
  title,
}: {
  series: { label: string; value: number }[];
  title: string;
}) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...series.map((point) => point.value));
  const plotWidth = CHART_WIDTH - LABEL_WIDTH - VALUE_GUTTER;
  const height = series.length * ROW_HEIGHT + 8;
  const scale = (value: number) => (max > 0 ? (Math.max(0, value) / max) * plotWidth : 0);
  // A horizontal bar: square at the baseline, 4px rounded at the data end.
  const barPath = (y: number, width: number) => {
    const r = Math.min(4, width / 2, BAR_THICKNESS / 2);
    const x = LABEL_WIDTH;
    return `M${x},${y} h${width - r} a${r},${r} 0 0 1 ${r},${r} v${BAR_THICKNESS - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${width - r} z`;
  };

  return (
    <figure className="report-chart">
      <figcaption className="strong">{title}</figcaption>
      <svg
        role="img"
        aria-label={`${title}: ${series.map((point) => `${point.label} ${formatValue(point.value)}`).join(', ')}`}
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        width="100%"
        style={{ maxWidth: CHART_WIDTH, overflow: 'visible' }}
      >
        <line
          x1={LABEL_WIDTH}
          x2={LABEL_WIDTH}
          y1={0}
          y2={height}
          stroke="#c8c7c1"
          strokeWidth={1}
        />
        {series.map((point, index) => {
          const y = index * ROW_HEIGHT + (ROW_HEIGHT - BAR_THICKNESS) / 2;
          const width = scale(point.value);
          return (
            <g
              key={`${point.label}-${index}`}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            >
              {/* The hit target is the whole row, larger than the bar. */}
              <rect
                x={0}
                y={index * ROW_HEIGHT}
                width={CHART_WIDTH}
                height={ROW_HEIGHT}
                fill="transparent"
              />
              <text
                x={LABEL_WIDTH - 8}
                y={y + BAR_THICKNESS / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={12}
                fill="currentColor"
              >
                {point.label.length > 24 ? `${point.label.slice(0, 23)}…` : point.label}
              </text>
              {width > 0 && (
                <path
                  d={barPath(y, width)}
                  fill={BAR}
                  opacity={hover === null || hover === index ? 1 : 0.55}
                />
              )}
              <text
                x={LABEL_WIDTH + width + 6}
                y={y + BAR_THICKNESS / 2}
                dominantBaseline="middle"
                fontSize={12}
                fill="currentColor"
              >
                {formatValue(point.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && series[hover] && (
        <div className="report-tooltip" role="status">
          <span className="strong">{series[hover].label}</span>: {formatValue(series[hover].value)}
        </div>
      )}
    </figure>
  );
};

const METRICS: { value: ReportSpec['metric']; label: string }[] = [
  { value: 'count', label: 'Number of submissions' },
  { value: 'sum', label: 'Total of' },
  { value: 'avg', label: 'Average of' },
  { value: 'min', label: 'Lowest' },
  { value: 'max', label: 'Highest' },
];

export const Reports = ({ formId }: { formId: string }) => {
  const { Formio } = useFormioContext();
  const base = Formio.projectUrl || Formio.baseUrl;
  const [components, setComponents] = useState<unknown[] | null>(null);
  const [spec, setSpec] = useState<ReportSpec>({
    groupBy: '',
    metric: 'count',
    metricField: '',
    dateBucket: '',
    unwind: '',
  });
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    new Formio(`${base}/form/${formId}`)
      .loadForm()
      .then((form: { components: unknown[] }) => setComponents(form.components))
      .catch((err: unknown) => console.log('Error while loading the form:', err));
  }, [Formio, base, formId]);

  const fields: Field[] = useMemo(() => (components ? getFields(components) : []), [components]);
  const groupFields = fields.filter(
    (field) =>
      !field.isGrid &&
      ['select', 'resource', 'radio', 'textfield', 'checkbox', 'number'].includes(field.type),
  );
  const numberFields = fields.filter((field) => ['number', 'currency'].includes(field.type));
  const grids = fields.filter((field) => field.isGrid);

  const runReport = async () => {
    setError('');
    setLoading(true);
    try {
      const params = buildReportQuery(spec, fields);
      const data = await Formio.makeRequest(
        null,
        'report',
        `${base}/form/${formId}/report?${params.toString()}`,
        'GET',
      );
      setResult(data as ReportResult);
    } catch (err) {
      setResult(null);
      setError(typeof err === 'string' ? err : 'The report could not be run.');
    } finally {
      setLoading(false);
    }
  };

  const metricLabel =
    spec.metric === 'count'
      ? 'Number of submissions'
      : `${METRICS.find((metric) => metric.value === spec.metric)?.label} ${
          fields.find((field) => field.path === spec.metricField)?.label || ''
        }`;
  const groupLabel = [
    fields.find((field) => field.path === spec.groupBy)?.label,
    spec.dateBucket ? `created (${spec.dateBucket})` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  const title = groupLabel ? `${metricLabel} by ${groupLabel}` : metricLabel;
  const series = result ? reportSeries(result) : [];

  const downloadCsv = () => {
    const blob = new Blob([reportCsv(series, metricLabel)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${formId}-report.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const canRun = spec.metric === 'count' || !!spec.metricField;

  return (
    <div className="panel view-data active reports">
      <div className="data-toolbar" aria-label="Report controls">
        <label className="data-toolbar-item">
          Show{' '}
          <select
            aria-label="Measure"
            value={spec.metric}
            onChange={(event) =>
              setSpec({ ...spec, metric: event.target.value as ReportSpec['metric'] })
            }
          >
            {METRICS.map((metric) => (
              <option key={metric.value} value={metric.value}>
                {metric.label}
              </option>
            ))}
          </select>
          {spec.metric !== 'count' && (
            <select
              aria-label="Measured field"
              value={spec.metricField}
              onChange={(event) => setSpec({ ...spec, metricField: event.target.value })}
            >
              <option value="">Choose a number field</option>
              {numberFields.map((field) => (
                <option key={field.path} value={field.path}>
                  {field.label}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="data-toolbar-item">
          Group by{' '}
          <select
            aria-label="Group by"
            value={spec.groupBy}
            onChange={(event) => setSpec({ ...spec, groupBy: event.target.value })}
          >
            <option value="">Nothing</option>
            {groupFields.map((field) => (
              <option key={field.path} value={field.path}>
                {field.label}
              </option>
            ))}
          </select>
        </label>
        <label className="data-toolbar-item">
          Over time{' '}
          <select
            aria-label="Over time"
            value={spec.dateBucket}
            onChange={(event) =>
              setSpec({ ...spec, dateBucket: event.target.value as ReportSpec['dateBucket'] })
            }
          >
            <option value="">No</option>
            <option value="day">By day</option>
            <option value="month">By month</option>
            <option value="year">By year</option>
          </select>
        </label>
        {grids.length > 0 && (
          <label className="data-toolbar-item">
            One row per line of{' '}
            <select
              aria-label="One row per line of"
              value={spec.unwind}
              onChange={(event) => setSpec({ ...spec, unwind: event.target.value })}
            >
              <option value="">Not needed</option>
              {grids.map((field) => (
                <option key={field.path} value={field.path}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="button small" disabled={!canRun || loading} onClick={runReport}>
          {loading ? 'Running…' : 'Run report'}
        </button>
        {result && series.length > 0 && (
          <button className="button small withiconright" onClick={downloadCsv}>
            Download CSV <i className="ri-download-2-line"></i>
          </button>
        )}
      </div>

      {error && (
        <div className="helptext" role="alert">
          {error}
        </div>
      )}
      {result && series.length === 0 && <div className="helptext">No submissions match.</div>}
      {result && series.length > 0 && (
        <div className="report-result">
          <BarChart series={series} title={title} />
          {result.truncated && (
            <div className="helptext">Showing the first {series.length} groups.</div>
          )}
          <table className="report-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{groupLabel || 'Group'}</th>
                <th scope="col">{metricLabel}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point, index) => (
                <tr key={`${point.label}-${index}`}>
                  <td>{point.label}</td>
                  <td>{formatValue(point.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
