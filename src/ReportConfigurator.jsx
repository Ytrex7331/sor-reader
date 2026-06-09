import { useState, useMemo, useEffect } from 'react'
import Plot from 'react-plotly.js'

function Card({ title, description, enabled, onToggle, onMoveUp, onMoveDown, canMoveUp, canMoveDown }) {
  return (
    <div className={`rounded-2xl border p-4 transition ${enabled ? 'bg-slate-800/60 ring-2 ring-cyan-400' : 'bg-slate-900/80 hover:border-slate-600'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-1 text-xs text-slate-400">{description}</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => onToggle(!enabled)}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${enabled ? 'bg-cyan-400 text-slate-900' : 'bg-slate-800 text-slate-400'}`}
          >
            {enabled ? 'Visible' : 'Hidden'}
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
            >↑</button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
            >↓</button>
          </div>
        </div>
      </div>
    </div>
  )
}
function extractTracePoints(trace) {
  if (!trace) return [];
  if (trace.dataPoints?.segments) {
    return trace.dataPoints.segments.flatMap(seg => seg.traceData);
  }
  return trace.traceData || [];
}

const AVAILABLE_SEGMENTS = [
  { key: 'general', title: 'Segment A', name: 'General Information', description: 'Cable IDs, fiber type, and location details' },
  { key: 'fixed', title: 'Segment B', name: 'Fixed Parameters', description: 'Measurement settings, IOR, and thresholds' },
  { key: 'trace', title: 'Segment C', name: 'Trace Visualization', description: 'Interactive OTDR trace line chart' },
  { key: 'events', title: 'Segment D', name: 'Key Events Table', description: 'Splice and reflectance event summary' },
]

export default function ReportConfigurator({ 
  visible, 
  onClose, 
  onPrint, 
  activeTrace, 
  metrics, 
  reportRef, 
  snapshotImg
}) {
  const [segmentOrder, setSegmentOrder] = useState(AVAILABLE_SEGMENTS.map((segment) => segment.key))
  const [enabledSegments, setEnabledSegments] = useState(new Set(AVAILABLE_SEGMENTS.map((segment) => segment.key)))
  const [reportName, setReportName] = useState(activeTrace?.name || '')

  useEffect(() => {
    setReportName(activeTrace?.name || '')
  }, [activeTrace])

  const moveSegment = (key, direction) => {
    setSegmentOrder((order) => {
      const index = order.indexOf(key)
      if (index === -1) return order
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= order.length) return order
      const next = [...order]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const toggleSegment = (key) => {
    setEnabledSegments((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const resetSegments = () => {
    setSegmentOrder(AVAILABLE_SEGMENTS.map((segment) => segment.key))
    setEnabledSegments(new Set(AVAILABLE_SEGMENTS.map((segment) => segment.key)))
  }

  const preview = useMemo(() => {
    if (!activeTrace) return null

    const rawEvents = activeTrace.keyEvents?.events ?? activeTrace.keyEvents?.records ?? []
    const events = Array.isArray(rawEvents) ? rawEvents.map((ev) => {
      const spliceLossValue = typeof ev.spliceLoss === 'number' ? ev.spliceLoss : Number(ev.spliceLoss) || 0
      const reflectanceValue = typeof ev.reflectance === 'number' ? ev.reflectance : Number(ev.reflectance) || 0
      return {
        eventNumber: ev.eventNumber ?? ev.number ?? '--',
        distanceKm: typeof ev.distanceKm === 'number' ? ev.distanceKm : typeof ev.distance === 'number' ? ev.distance : null,
        spliceLossValue,
        spliceLoss: Number.isFinite(spliceLossValue) ? spliceLossValue.toFixed(3) : '--',
        reflectanceValue,
        reflectance: Number.isFinite(reflectanceValue) ? reflectanceValue.toFixed(3) : '--',
        eventCode: ev.eventCode ?? '--',
        lossTech: ev.lossTech ?? '--',
        comment: ev.comment?.trim() || '',
        isLastEvent: ev.isLastEvent ?? false,
        endToEndSummary: ev.endToEndSummary ?? null,
      }
    }) : []

    return {
      title: activeTrace.name || 'OTDR Report',
      supplier: activeTrace.supplier ?? {},
      general: activeTrace.general ?? {},
      fixed: activeTrace.fixed ?? {},
      tracePoints: activeTrace.dataPoints?.segments?.[0]?.traceData ?? [],
      events,
      metrics,
    }
  }, [activeTrace, metrics])

  const activeSegments = useMemo(() => segmentOrder.filter((key) => enabledSegments.has(key)), [segmentOrder, enabledSegments])

  const fixed = preview?.fixed || {}
  const unitsOfDistance = fixed.unitsOfDistance === 'mt' ? 'm' : 'km'
  const distanceScale = unitsOfDistance === 'm' ? 1000 : 1
  const distanceAxisLabel = `Distance (${unitsOfDistance})`
  const lossThreshold = Number.isFinite(fixed.lossThreshold) ? fixed.lossThreshold : 0.75
  const reflectanceThreshold = Number.isFinite(fixed.reflectanceThreshold) ? fixed.reflectanceThreshold : Number.POSITIVE_INFINITY
  
  // Report PASS/FAIL based on static thresholds (preview-only)
  const failedEventsCount = preview?.events?.filter((event) => {
    const spliceLoss = Number(event.spliceLoss) || 0
    const reflectance = Number(event.reflectance) || 0
    return spliceLoss > lossThreshold || reflectance > reflectanceThreshold
  }).length || 0
  
  const reportStatus = failedEventsCount > 0 ? 'FAIL' : 'PASS'
  const reportStatusClasses = reportStatus === 'FAIL' ? 'text-rose-300 bg-rose-950/80 border-rose-600/50' : 'text-emerald-300 bg-emerald-950/80 border-emerald-600/50'

  const formatDistanceValue = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return `${(Number(value) * distanceScale).toFixed(unitsOfDistance === 'm' ? 1 : 4)}`
  }

  const formatDateTime = (value) => {
    if (!value) return '--'
    const date = new Date(value)
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString()
  }

  const renderSegment = (key) => {
    if (!preview) return null
    switch (key) {
      case 'general': {
        const { supplier, general } = preview
        return (
          <section key={key} className="rounded-3xl border border-slate-200/60 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Segment A</p>
                <h2 className="text-xl font-semibold text-slate-900">General Information</h2>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Supplier</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{supplier.supplier || '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Cable ID</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{general.cableId || '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Fiber ID</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{general.fiberId || '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Fiber Type</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{general.fiberType || '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4 sm:col-span-2">
                <p className="text-xs text-slate-500">Nominal Wavelength</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{general.nominalWavelength ? `${general.nominalWavelength} nm` : '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4 sm:col-span-2">
                <p className="text-xs text-slate-500">Location</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{general.originatingLocation || '--'} → {general.terminatingLocation || '--'}</p>
              </div>
            </div>
          </section>
        )
      }
      case 'fixed': {
        return (
          <section key={key} className="rounded-3xl border border-slate-200/60 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Segment B</p>
                <h2 className="text-xl font-semibold text-slate-900">Fixed Parameters</h2>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Date of Report Generation</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{formatDateTime(fixed.dateTime)}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Units</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{unitsOfDistance === 'm' ? 'Meters (m)' : 'Kilometers (km)'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Index of Refraction</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{fixed.indexOfRefraction?.toFixed(4) ?? '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Averaging Time</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{fixed.averagingTime?.toFixed(2) ?? '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Loss Threshold</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{Number.isFinite(fixed.lossThreshold) ? `${fixed.lossThreshold.toFixed(3)} dB` : '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
                <p className="text-xs text-slate-500">Reflectance Threshold</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{Number.isFinite(fixed.reflectanceThreshold) ? `${fixed.reflectanceThreshold.toFixed(3)} dB` : '--'}</p>
              </div>
              <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4 sm:col-span-2">
                <p className="text-xs text-slate-500">End of Fibre Threshold</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{Number.isFinite(fixed.endOfFibreThreshold) ? `${fixed.endOfFibreThreshold.toFixed(3)} dB` : '--'}</p>
              </div>
            </div>
          </section>
        )
      }
      case 'trace': {
        return (
          <section key={key} className="rounded-3xl border border-slate-200/60 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Segment C</p>
                <h2 className="text-xl font-semibold text-slate-900">Trace Visualization</h2>
              </div>
            </div>
            <div className="rounded-3xl border border-slate-200/80 bg-slate-50 p-4">
              <Plot
                data={[{
                  x: preview.tracePoints.map((point) => point.distance * distanceScale),
                  y: preview.tracePoints.map((point) => point.db),
                  type: 'scatter',
                  mode: 'lines',
                  line: { color: '#0ea5e9', width: 2 },
                  hovertemplate: `%{x:.2f} ${unitsOfDistance}<br>%{y:.2f} dB<extra></extra>`,
                }]}
                layout={{
                  autosize: true,
                  margin: { l: 55, r: 20, t: 30, b: 45 },
                  paper_bgcolor: '#f8fafc',
                  plot_bgcolor: '#ffffff',
                  font: { color: '#0f172a', family: 'Inter, system-ui, sans-serif' },
                  xaxis: { title: { text: distanceAxisLabel }, gridcolor: '#e2e8f0', zerolinecolor: '#cbd5e1' },
                  yaxis: { title: { text: 'Loss (dB)' }, gridcolor: '#e2e8f0', zerolinecolor: '#cbd5e1' },
                }}
                config={{ responsive: true, displayModeBar: true, staticPlot: false }}
                style={{ width: '100%', minHeight: '320px' }}
              />
            </div>
          </section>
        )
      }
      case 'events': {
        return (
          <section key={key} className="rounded-3xl border border-slate-200/60 bg-white p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Segment D</p>
                <h2 className="text-xl font-semibold text-slate-900">Key Events Table</h2>
              </div>
            </div>
            <div className="overflow-hidden rounded-3xl border border-slate-200/80 bg-slate-50">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-slate-100 text-left text-xs uppercase tracking-[0.24em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">#</th>
                    <th className="px-3 py-3">Distance</th>
                    <th className="px-3 py-3">Splice Loss</th>
                    <th className="px-3 py-3">Reflectance</th>
                    <th className="px-3 py-3">Code</th>
                    <th className="px-3 py-3">Tech</th>
                    <th className="px-3 py-3">Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.events.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-slate-500">No events available</td></tr>
                  ) : preview.events.map((event, index) => {
                    const isSplice = event.eventCode?.includes('1A9999')
                    const label = isSplice ? 'Splice' : event.eventCode
                    const failedSplice = event.spliceLossValue > lossThreshold
                    const failedReflectance = event.reflectanceValue > reflectanceThreshold
                    const flagged = failedSplice || failedReflectance
                    return (
                      <tr key={index} className={`${flagged ? 'bg-rose-50/80' : 'odd:bg-white even:bg-slate-50'} hover:bg-slate-100`}>
                        <td className="border-t px-3 py-3 font-medium text-slate-700">{event.eventNumber}</td>
                        <td className="border-t px-3 py-3 font-mono text-slate-700">{formatDistanceValue(event.distanceKm)} {unitsOfDistance}</td>
                        <td className={`border-t px-3 py-3 font-mono ${failedSplice ? 'text-rose-600' : 'text-slate-700'}`}>{event.spliceLoss} dB</td>
                        <td className={`border-t px-3 py-3 font-mono ${failedReflectance ? 'text-rose-600' : 'text-slate-700'}`}>{event.reflectance} dB</td>
                        <td className="border-t px-3 py-3 text-slate-600">{label}</td>
                        <td className="border-t px-3 py-3 text-slate-600">{event.lossTech}</td>
                        <td className="border-t px-3 py-3 text-slate-500">{event.comment || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )
      }
      default:
        return null
    }
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/60 p-8">
      <div className="w-full rounded-3xl bg-slate-900/95 shadow-2xl ring-1 ring-slate-800 flex overflow-hidden">
        <div className="w-[360px] border-r border-slate-800 p-6 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Report Builder</h3>
              <p className="text-sm text-slate-400">Activate and reorder modular segments</p>
            </div>
            <button onClick={resetSegments} className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">Reset</button>
          </div>

          <div className="mt-5 space-y-3">
            {segmentOrder.map((segmentKey, index) => {
              const segment = AVAILABLE_SEGMENTS.find((item) => item.key === segmentKey)
              if (!segment) return null
              const enabled = enabledSegments.has(segment.key)
              return (
                <Card
                  key={segment.key}
                  title={`${segment.title}: ${segment.name}`}
                  description={segment.description}
                  enabled={enabled}
                  onToggle={() => toggleSegment(segment.key)}
                  onMoveUp={() => moveSegment(segment.key, 'up')}
                  onMoveDown={() => moveSegment(segment.key, 'down')}
                  canMoveUp={index > 0}
                  canMoveDown={index < segmentOrder.length - 1}
                />
              )
            })}
          </div>

          <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-950/90 p-4 text-sm text-slate-300">
            <p className="font-semibold text-white">Report Actions</p>
            <div className="mt-3 space-y-3">
              <button onClick={onClose} className="w-full rounded-2xl bg-slate-800 px-4 py-3 text-sm text-slate-300">Close / Return</button>
              <button onClick={() => onPrint({}, 'print')} className="w-full rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-900">Print Report</button>
              <button onClick={() => onPrint({}, 'pdf')} className="w-full rounded-2xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">Download PDF</button>
            </div>
          </div>
        </div>

        <div className="flex-1 p-6">
          <div ref={reportRef} className="printable-report h-full overflow-auto rounded-lg bg-slate-50 p-6 text-slate-900">
            {preview ? (
              <div className="space-y-6">
                <section className="rounded-3xl border border-slate-200/80 bg-white p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <label className="block text-xs uppercase tracking-[0.24em] text-slate-500">Report Name</label>
                      <input
                        type="text"
                        value={reportName}
                        onChange={(e) => setReportName(e.target.value)}
                        className="mt-2 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-xl font-semibold text-slate-900 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-200"
                      />
                    </div>
                    <div className={`rounded-3xl border px-4 py-3 text-sm font-semibold ${reportStatusClasses}`}>
                      {reportStatus}
                    </div>
                  </div>
                  <div className="mt-3 text-sm text-slate-600">This report evaluates all KeyEvents against fixed thresholds. Any splice or reflectance failure marks the overall status as FAIL.</div>
                </section>

                {activeSegments.length === 0 && (
                  <div className="rounded-3xl border border-dashed border-slate-400 bg-slate-100 p-6 text-center text-slate-600">
                    Enable report segments in the left panel to assemble the report.
                  </div>
                )}

                {activeSegments.map(renderSegment)}
              </div>
            ) : (
              <div className="text-center text-slate-600">Select a trace to preview the report.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}