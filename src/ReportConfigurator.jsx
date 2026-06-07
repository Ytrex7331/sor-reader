import { useState, useMemo } from 'react'

function Card({ title, description, enabled, onToggle }) {
  return (
    <div
      onClick={() => onToggle(!enabled)}
      className={`cursor-pointer select-none rounded-2xl border p-4 transition-shadow ${enabled ? 'ring-2 ring-cyan-400 bg-slate-800/60' : 'bg-slate-900/80 hover:border-slate-600'}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-1 text-xs text-slate-400">{description}</div>
        </div>
        <div className="ml-3 flex items-center">
          <div className={`h-8 w-8 rounded-full flex items-center justify-center ${enabled ? 'bg-cyan-400 text-slate-900' : 'bg-slate-800 text-slate-400'}`}>
            {enabled ? '👁️' : '✖️'}
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
export default function ReportConfigurator({ visible, onClose, onPrint, activeTrace, metrics, reportRef, snapshotImg }) {
  const [toggles, setToggles] = useState({
    header: true,
    general: true,
    settings: true,
    analysis: true,
    thumbnail: true,
    rawTable: true,
    events: true,
  })

  const toggleAll = (v) => setToggles(Object.fromEntries(Object.keys(toggles).map(k => [k, v])))
  const resetDefault = () => setToggles({ header: true, general: true, settings: true, analysis: true, thumbnail: true, rawTable: true, events: true })

  const preview = useMemo(() => {
    if (!activeTrace) return null

    const allPoints = extractTracePoints(activeTrace)

    // The real SOR parser returns keyEvents.events shaped:
    //   { eventNumber, distanceKm, spliceLoss, reflectance, eventCode,
    //     lossTech, slope, markers, comment, isLastEvent, endToEndSummary }
    // Normalise into display-ready strings with nullish fallbacks so any
    // unexpected or partial structure cannot crash the renderer.
    const rawEvents = activeTrace.keyEvents?.events ?? activeTrace.keyEvents?.records ?? []
    const events = Array.isArray(rawEvents) ? rawEvents.map((ev) => ({
      eventNumber:     ev.eventNumber  ?? ev.number ?? '--',
      distanceKm:      typeof ev.distanceKm  === 'number' ? ev.distanceKm.toFixed(4)  : '--',
      spliceLoss:      typeof ev.spliceLoss   === 'number' ? ev.spliceLoss.toFixed(3)   : '--',
      reflectance:     ev.reflectance  != null              ? ev.reflectance.toFixed(3)  : 'n/m',
      eventCode:       ev.eventCode    ?? '--',
      lossTech:        ev.lossTech     ?? '--',
      comment:         ev.comment?.trim() || '',
      isLastEvent:     ev.isLastEvent  ?? false,
      endToEndSummary: ev.endToEndSummary ?? null,
    })) : []

    return {
      title:       activeTrace.name,
      meta:        activeTrace.metadata,
      markers:     metrics,
      firstPoints: allPoints.slice(0, 4),
      events,
    }
  }, [activeTrace, metrics])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/60 p-8">
      <div className="w-full rounded-3xl bg-slate-900/95 shadow-2xl ring-1 ring-slate-800 flex overflow-hidden">
        {/* Left control grid */}
        <div className="w-[360px] border-r border-slate-800 p-6 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Report Template</h3>
            <div className="text-sm text-slate-400">Configure sections</div>
          </div>
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <button onClick={() => toggleAll(true)} className="rounded-full bg-cyan-600/20 px-3 py-1 text-sm text-cyan-300">Toggle All</button>
              <button onClick={() => toggleAll(false)} className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">Uncheck All</button>
              <button onClick={resetDefault} className="ml-auto rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">Reset Default</button>
            </div>

            <div className="mt-3 grid gap-3">
              <Card title="Report Header & Branding" description="Title, project name and generation date" enabled={toggles.header} onToggle={(v) => setToggles(s => ({ ...s, header: v }))} />
              <Card title="General Information" description="Location, fiber & cable IDs, notes" enabled={toggles.general} onToggle={(v) => setToggles(s => ({ ...s, general: v }))} />
              <Card title="Test Settings & Parameters" description="Wavelength, pulse, IOR, backscatter" enabled={toggles.settings} onToggle={(v) => setToggles(s => ({ ...s, settings: v }))} />
              <Card title="Analysis Results" description="4-marker values and attenuation" enabled={toggles.analysis} onToggle={(v) => setToggles(s => ({ ...s, analysis: v }))} />
              <Card title="Interactive Trace Thumbnail" description="Static mini-graph snapshot" enabled={toggles.thumbnail} onToggle={(v) => setToggles(s => ({ ...s, thumbnail: v }))} />
              <Card title="Event Table" description="Parsed KeyEvents and payload details" enabled={toggles.events} onToggle={(v) => setToggles(s => ({ ...s, events: v }))} />
              <Card title="Raw Marker Cross-Reference" description="Coordinates for A-Ref, A, B, B-Ref" enabled={toggles.rawTable} onToggle={(v) => setToggles(s => ({ ...s, rawTable: v }))} />
            </div>
          </div>

          <div className="mt-6 flex gap-3 flex-wrap">
            <button onClick={onClose} className="flex-1 rounded-2xl bg-slate-800 px-4 py-3 text-sm font-medium text-slate-300">Close / Return</button>
            <button onClick={() => onPrint(toggles, 'print')} className="flex-1 rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-900">Print Report</button>
            <button onClick={() => onPrint(toggles, 'pdf')} className="flex-1 rounded-2xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">Download PDF</button>
          </div>
        </div>

        {/* Right preview */}
        <div className="flex-1 p-6">
          <div ref={reportRef} className="printable-report h-full overflow-auto rounded-lg bg-slate-50 p-6 text-slate-900">
            {preview ? (
              <div className="space-y-6">
                {toggles.header && (
                  <div>
                    <h1 className="text-2xl font-bold">{preview.title}</h1>
                    <div className="mt-1 text-sm text-slate-600">Generated: {new Date().toLocaleString()}</div>
                  </div>
                )}

                {toggles.general && (
                  <div className="rounded-md border p-3 bg-white">
                    <div>Location: {preview.meta.location || '--'}</div>
                    <div>Cable ID: {preview.meta.cableId || '--'}</div>
                    <div>Fiber ID: {preview.meta.fiberId || '--'}</div>
                    <div>Operator: {preview.meta.operator || '--'}</div>
                    <div>Notes: {preview.meta.comments || '--'}</div>
                  </div>
                )}

                {toggles.settings && (
                  <div className="rounded-md border p-3 grid grid-cols-2 gap-3 bg-white">
                    <div><div className="text-xs text-slate-600">Wavelength</div><div className="font-medium">{preview.meta.wavelength}</div></div>
                    <div><div className="text-xs text-slate-600">Pulse Width</div><div className="font-medium">{preview.meta.pulseWidth}</div></div>
                    <div><div className="text-xs text-slate-600">IOR</div><div className="font-medium">{preview.meta.ior}</div></div>
                    <div><div className="text-xs text-slate-600">Backscatter</div><div className="font-medium">{preview.meta.backscatterCoefficient}</div></div>
                  </div>
                )}

                {toggles.analysis && metrics && (
                  <div className="rounded-md border p-3 bg-white">
                    <div className="text-xs text-slate-600">Distance A–B</div>
                    <div className="font-medium">{metrics.dx.toFixed(3)} km</div>
                    <div className="text-xs text-slate-600 mt-2">Event Loss (4pt)</div>
                    <div className="font-medium">{metrics.loss.toFixed(3)} dB</div>
                    <div className="text-xs text-slate-600 mt-2">Section Attenuation</div>
                    <div className="font-medium">{metrics.att.toFixed(3)} dB/km</div>
                  </div>
                )}

                {toggles.thumbnail && (
                  <div className="rounded-md border p-3 bg-white">
                    <div className="text-xs text-slate-600 mb-2">Trace Thumbnail</div>
                    <div 
                      className="report-chart-wrapper" 
                      style={{ 
                        width: '100%', 
                        maxWidth: '800px', // Prevents the image from expanding indefinitely on huge pages
                        margin: '0 auto',
                        overflow: 'hidden'
                      }}
                    >
                      {snapshotImg ? (
                        <img 
                          id="reportTraceSnapshot" 
                          src={snapshotImg} 
                          alt="OTDR Trace Graph" 
                          style={{ 
                            width: '100%', 
                            height: 'auto',        // Enforces automatic proportional height evaluation
                            objectFit: 'contain',  // Preserves aspect ratio letterboxing if stretched
                            display: 'block' 
                          }} 
                        />
                      ) : (
                        <div className="text-sm text-slate-400 italic py-4 text-center bg-slate-50 border border-dashed rounded-md">
                          No trace snapshot image data available.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {toggles.events && preview?.events && (
                  <div className="rounded-md border p-3 bg-white">
                    <div className="text-xs text-slate-600">KeyEvents Summary</div>
                    {preview.events.length > 0 ? (
                      <table className="mt-2 w-full text-sm border-collapse">
                        <thead className="text-left text-xs text-slate-600 bg-slate-50">
                          <tr>
                            <th className="p-2 border-b">#</th>
                            <th className="p-2 border-b">Distance</th>
                            <th className="p-2 border-b">Splice Loss</th>
                            <th className="p-2 border-b">Reflectance</th>
                            <th className="p-2 border-b">Code</th>
                            <th className="p-2 border-b">Tech</th>
                            <th className="p-2 border-b">Comment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.events.map((event, index) => (
                            <tr
                              key={index}
                              className={event.isLastEvent ? 'bg-cyan-50' : 'hover:bg-slate-50/50'}
                            >
                              <td className="p-2 border-t font-medium text-slate-800">{event.eventNumber}</td>
                              <td className="p-2 border-t font-mono text-slate-700">{event.distanceKm} km</td>
                              <td className="p-2 border-t font-mono text-slate-700">{event.spliceLoss} dB</td>
                              <td className="p-2 border-t font-mono text-slate-500">{event.reflectance} dB</td>
                              <td className="p-2 border-t font-mono text-xs text-slate-600">{event.eventCode}</td>
                              <td className="p-2 border-t text-xs text-slate-500">{event.lossTech}</td>
                              <td className="p-2 border-t text-slate-400 text-xs">{event.comment || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="mt-2 rounded-md bg-slate-100 p-3 text-sm text-slate-600">No KeyEvents records available for this trace.</div>
                    )}
                    {/* End-to-end summary from the last key event */}
                    {preview.events.at(-1)?.endToEndSummary && (
                      <div className="mt-3 rounded-md bg-cyan-50 border border-cyan-100 p-3 text-xs text-slate-700 grid grid-cols-2 gap-2">
                        <div><span className="text-slate-500">End-to-End Loss</span><br /><span className="font-mono font-semibold">{preview.events.at(-1).endToEndSummary.endToEndLoss?.toFixed(3)} dB</span></div>
                        <div><span className="text-slate-500">Optical Return Loss</span><br /><span className="font-mono font-semibold">{preview.events.at(-1).endToEndSummary.opticalReturnLoss?.toFixed(3)} dB</span></div>
                      </div>
                    )}
                  </div>
                )}
                {toggles.rawTable && metrics && (
                  <div className="rounded-md border p-3 bg-white">
                    <div className="text-xs text-slate-600">Marker Cross-Reference</div>
                    <table className="mt-2 w-full text-sm border-collapse">
                      <thead className="text-left text-xs text-slate-600 bg-slate-50">
                        <tr><th className="p-2 border-b">Marker</th><th className="p-2 border-b">Distance</th><th className="p-2 border-b">dB</th></tr>
                      </thead>
                      <tbody>
                        {metrics.pts.map((p, i) => (
                          <tr key={i} className="hover:bg-slate-50/50">
                            <td className="p-2 border-t font-medium">{['A-Ref','A','B','B-Ref'][i]}</td>
                            <td className="p-2 border-t font-mono">{p.distance.toFixed(6)} km</td>
                            <td className="p-2 border-t font-mono">{p.db.toFixed(3)} dB</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
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