import { useMemo, useState, useCallback, useRef } from 'react'
import Plot from 'react-plotly.js'
import { generateMockSorData } from './mockSorData'

const markerLabels = ['A-Ref', 'A', 'B', 'B-Ref']
const markerColors = ['#00F5FF', '#FF7A18', '#FF2D95', '#7CFC00']
const palette = [
  '#00F5FF',
  '#7CFC00',
  '#FF7A18',
  '#FF2D95',
  '#A855F7',
  '#F472B6',
  '#38BDF8',
]

function findNearestPoint(trace, xValue) {
  const points = trace.traceData
  let low = 0
  let high = points.length - 1

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (points[mid].distance < xValue) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  const candidateA = points[Math.max(0, low - 1)]
  const candidateB = points[low]
  if (!candidateB) return candidateA
  return Math.abs(candidateA.distance - xValue) < Math.abs(candidateB.distance - xValue) ? candidateA : candidateB
}

function calcMarkerMetrics(activeTrace, markerValues) {
  if (!activeTrace) return null

  const points = markerValues.map((distance) => findNearestPoint(activeTrace, distance))
  const [pARef, pA, pB, pBRef] = points

  const deltaX = pB.distance - pA.distance
  const sectionAttenuation = deltaX > 0 ? (pB.db - pA.db) / deltaX : 0

  const denomPre = pA.distance - pARef.distance
  const denomPost = pBRef.distance - pB.distance
  const preSlope = Math.abs(denomPre) > 1e-9 ? (pA.db - pARef.db) / denomPre : 0
  const postSlope = Math.abs(denomPost) > 1e-9 ? (pBRef.db - pB.db) / denomPost : 0

  const yPreAtB = pA.db + preSlope * (pB.distance - pA.distance)
  const yPostAtA = pB.db + postSlope * (pA.distance - pB.distance)

  const rawLoss = 0.5 * ((yPreAtB - pB.db) + (pA.db - yPostAtA))

  return {
    points,
    deltaX,
    loss: Math.max(0, rawLoss),
    sectionAttenuation,
    preSlope,
    postSlope,
  }
}

function App() {
  const [files, setFiles] = useState([])
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set())
  const [markerPositions, setMarkerPositions] = useState([2.0, 12.5, 25.8, 30.2])

  // Efficiently derive selected traces
  const selectedTraces = useMemo(() => {
    if (files.length === 0) return []
    const sel = []
    selectedFileIds.forEach((id) => {
      const f = files.find((x) => x.id === id)
      if (f) sel.push(f)
    })
    return sel
  }, [files, selectedFileIds])

  const activeTrace = selectedTraces[0] || null
  const metrics = useMemo(() => calcMarkerMetrics(activeTrace, markerPositions), [activeTrace, markerPositions])

  const maxDistance = activeTrace ? activeTrace.traceData[activeTrace.traceData.length - 1].distance : 40

  const [selectedMarkerIndex, setSelectedMarkerIndex] = useState(null)
  const plotRef = useRef(null)
  const containerRef = useRef(null)

  const getXPixel = (distanceValue) => {
    const gd = plotRef.current?.el
    if (!gd?._fullLayout) return null
    const xaxis = gd._fullLayout.xaxis
    return xaxis.l2p(distanceValue) + gd._fullLayout.margin.l
  }

  const getDataValue = (pixelX) => {
    const gd = plotRef.current?.el
    if (!gd?._fullLayout) return null
    const xaxis = gd._fullLayout.xaxis
    return xaxis.p2l(pixelX - gd._fullLayout.margin.l)
  }

  const startDrag = (index, e) => {
    e.preventDefault()
    setSelectedMarkerIndex(index)

    const onMove = (moveEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = moveEvent.clientX - rect.left
      const dataVal = getDataValue(px)
      if (dataVal === null) return
      const clamped = Math.max(0, Math.min(dataVal, maxDistance))
      const nearest = findNearestPoint(activeTrace, clamped)
      setMarkerPositions((prev) => {
        const copy = [...prev]
        copy[index] = nearest.distance
        return copy
      })
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleMarkerChange = (index, rawValue) => {
    if (!activeTrace) return
    const num = Number(rawValue)
    if (Number.isNaN(num)) return
    const clamped = Math.max(0, Math.min(num, maxDistance))
    const nearest = findNearestPoint(activeTrace, clamped)
    setMarkerPositions((current) => {
      const copy = [...current]
      copy[index] = nearest.distance
      return copy
    })
  }

  const handlePlotClick = (event) => {
    if (!event || !event.points || event.points.length === 0) {
      setSelectedMarkerIndex(null)
      return
    }
    const clickedX = event.points[0].x
    if (clickedX == null) {
      setSelectedMarkerIndex(null)
      return
    }
    // select closest marker within threshold
    const threshold = Math.max(0.02, maxDistance * 0.005)
    let bestIndex = null
    let bestDist = Infinity
    markerPositions.forEach((m, i) => {
      const d = Math.abs(m - clickedX)
      if (d < bestDist) {
        bestDist = d
        bestIndex = i
      }
    })
    if (bestDist <= threshold) setSelectedMarkerIndex(bestIndex)
    else setSelectedMarkerIndex(null)
  }

  const handleFiles = useCallback(
    (incomingFiles) => {
      const nextFiles = []
      for (const file of incomingFiles) {
        const name = file.name || `Trace-${files.length + nextFiles.length + 1}.sor`
        nextFiles.push(generateMockSorData(name))
      }
      setFiles((current) => {
        const merged = [...current, ...nextFiles]
        return merged
      })

      // Select newly added files (append IDs) in a single Set update
      setSelectedFileIds((current) => {
        const copy = new Set(current)
        nextFiles.forEach((f) => copy.add(f.id))
        return copy
      })
    },
    [files.length]
  )

  const handleInputChange = (event) => {
    const incomingFiles = Array.from(event.target.files || [])
    if (incomingFiles.length) {
      handleFiles(incomingFiles)
    }
    event.target.value = ''
  }

  const handleDrop = (event) => {
    event.preventDefault()
    const incomingFiles = Array.from(event.dataTransfer.files || [])
    if (incomingFiles.length) {
      handleFiles(incomingFiles)
    }
  }

  const handleDragOver = (event) => {
    event.preventDefault()
  }

  const toggleSelected = (fileId, e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    setSelectedFileIds((current) => {
      const copy = new Set(current)
      if (copy.has(fileId)) copy.delete(fileId)
      else copy.add(fileId)
      return copy
    })
  }

  const handleRowClick = (fileId) => {
    // single-select on row click
    setSelectedFileIds(() => new Set([fileId]))
  }

  const handleSelectAll = () => {
    setSelectedFileIds(() => new Set(files.map((f) => f.id)))
  }

  const handleDeselectAll = () => {
    setSelectedFileIds(() => new Set())
  }

  const handleRelayout = (event) => {
    // No-op: we handle marker updates via SVG drag now
  }

  // memoize heavy derived arrays for performance when many files are selected
  const traceSeries = useMemo(() => {
    return selectedTraces.map((trace, index) => ({
      x: trace.traceData.map((point) => point.distance),
      y: trace.traceData.map((point) => point.db),
      type: 'scatter',
      mode: 'lines',
      name: trace.name,
      line: {
        color: palette[index % palette.length],
        width: 1.6,
      },
      hovertemplate: '%{x:.2f} km<br>%{y:.2f} dB<extra></extra>',
    }))
  }, [selectedTraces])

  // No longer using Plotly shapes; SVG overlay handles rendering

  const markerAnnotations = useMemo(() => {
    if (!activeTrace) return []
    return markerPositions.map((x, index) => ({
      x,
      y: 1.01,
      xref: 'x',
      yref: 'paper',
      text: markerLabels[index],
      showarrow: false,
      font: { color: markerColors[index], size: 13, family: 'Inter, system-ui, sans-serif' },
    }))
  }, [activeTrace, markerPositions])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-screen-2xl px-6 py-5">
        <header className="mb-6 flex items-center justify-between rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-glow">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-cyan-300">OTDR Analytics Prototype</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Fiber Trace Review Dashboard</h1>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-300 shadow-sm">
            Mock ingestion + live 4-marker analysis
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
          <aside className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/90 p-5 shadow-glow">
            <div>
              <h2 className="text-lg font-semibold text-white">File Explorer</h2>
              <p className="mt-1 text-sm text-slate-400">
                Drag .sor / .iolm here or click to generate mock trace data.
              </p>
            </div>

            <div
              className="group relative rounded-3xl border-2 border-dashed border-slate-700 bg-slate-950/80 px-4 py-9 text-center transition hover:border-cyan-400"
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept=".sor,.iolm"
                multiple
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                onChange={handleInputChange}
              />
              <div className="pointer-events-none">
                <p className="text-sm font-medium text-slate-100">Drop files here</p>
                <p className="mt-2 text-xs text-slate-400">or click to select mock OTDR files</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">Uploaded Traces</h3>
                <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">
                  {files.length} total
                </span>
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSelectAll}
                      className="rounded-full bg-cyan-500/10 px-3 py-1 text-sm font-medium text-cyan-300 ring-1 ring-cyan-500/10 hover:bg-cyan-600/10"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={handleDeselectAll}
                      className="text-sm text-slate-400 underline-offset-2 hover:underline"
                    >
                      Deselect All
                    </button>
                  </div>
                  <div className="text-xs text-slate-400">Showing up to {files.length} files</div>
                </div>

                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
                  {files.length === 0 ? (
                    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                      No mock traces loaded yet.
                    </div>
                  ) : (
                    files.map((file) => {
                      const selected = selectedFileIds.has(file.id)
                      return (
                        <div
                          key={file.id}
                          onClick={() => handleRowClick(file.id)}
                          className={`flex w-full items-center justify-between rounded-3xl border px-4 py-3 text-left transition cursor-pointer ${
                            selected ? 'border-cyan-400 bg-cyan-500/10 shadow-cyan-500/10' : 'border-slate-800 bg-slate-950/90 hover:border-slate-600'
                          }`}
                        >
                          <div>
                            <p className="text-sm font-medium text-white">{file.name}</p>
                            <p className="mt-1 text-xs text-slate-400">{file.metadata.wavelength} · {file.metadata.pulseWidth}</p>
                          </div>
                          <label className="flex items-center gap-2 text-slate-300" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(e) => toggleSelected(file.id, e)}
                              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400 focus:ring-cyan-400"
                            />
                          </label>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled
              className="mt-3 w-full rounded-3xl bg-slate-800 px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-500 transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              Generate Report
            </button>
          </aside>

          <main className="space-y-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-4 shadow-glow">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.24em] text-cyan-300">Interactive Trace Canvas</p>
                  <h2 className="text-2xl font-semibold text-white">dB vs Distance</h2>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300">
                  {selectedTraces.length > 0 ? `${selectedTraces.length} trace${selectedTraces.length > 1 ? 's' : ''} overlayed` : 'Select a trace to render'}
                </div>
              </div>

              <div className="h-[620px] rounded-3xl border border-slate-800 bg-slate-950/70 px-2 py-2">
                {selectedTraces.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 text-slate-500">
                    Load a trace to see the interactive chart.
                  </div>
                ) : (
                  <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
                    <Plot
                      ref={plotRef}
                      data={traceSeries}
                      layout={{
                        autosize: true,
                        margin: { l: 55, r: 30, t: 40, b: 50 },
                        paper_bgcolor: '#0f172a',
                        plot_bgcolor: '#020617',
                        font: { color: '#cbd5e1', family: 'Inter, system-ui, sans-serif' },
                        xaxis: {
                          title: { text: 'Distance (km)' },
                          gridcolor: '#334155',
                          zerolinecolor: '#334155',
                        },
                        yaxis: {
                          title: { text: 'Signal Level (dBm)' },
                          gridcolor: '#334155',
                          zerolinecolor: '#334155',
                        },
                        dragmode: false,
                        hovermode: 'closest',
                        annotations: markerAnnotations,
                        xaxis2: {
                          domain: [0, 1],
                        },
                        legend: {
                          orientation: 'v',
                          x: 0.98,
                          xanchor: 'right',
                          y: 0.98,
                          bgcolor: 'rgba(0,0,0,0.0)',
                          font: { size: 12 },
                        },
                        showlegend: true,
                      }}
                      style={{ width: '100%', height: '100%' }}
                      config={{ responsive: true, displayModeBar: true, editable: false }}
                      onRelayout={handleRelayout}
                      onClick={handlePlotClick}
                    />
                    {activeTrace && (
                      <svg
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: '100%',
                          pointerEvents: 'none',
                        }}
                      >
                        {markerPositions.map((x, i) => {
                          const px = getXPixel(x)
                          return px !== null ? (
                            <line
                              key={`marker-${i}`}
                              x1={px}
                              x2={px}
                              y1={0}
                              y2="100%"
                              stroke={markerColors[i]}
                              strokeWidth={selectedMarkerIndex === i ? 4 : 2}
                              strokeDasharray="5,5"
                              style={{
                                pointerEvents: 'all',
                                cursor: 'ew-resize',
                              }}
                              onMouseDown={(e) => startDrag(i, e)}
                            />
                          ) : null
                        })}
                      </svg>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 shadow-glow">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h3 className="text-xl font-semibold text-white">Trace Metadata</h3>
                    <p className="mt-1 text-sm text-slate-400">Realtime fiber parameters from the selected mock trace.</p>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  {activeTrace ? (
                    Object.entries(activeTrace.metadata).map(([label, value]) => (
                      <div key={label} className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{label.replace(/([A-Z])/g, ' $1')}</p>
                        <p className="mt-2 text-lg font-semibold text-white">{value}</p>
                      </div>
                    ))
                  ) : (
                    <div className="col-span-2 rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                      Select a trace to inspect metadata and event metrics.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6 shadow-glow">
                <div className="mb-5">
                  <h3 className="text-xl font-semibold text-white">4-Marker Readout</h3>
                  <p className="mt-1 text-sm text-slate-400">Live diagnostics from A-Ref, A, B, and B-Ref markers.</p>
                </div>

                <div className="mb-4 space-y-3">
                  {activeTrace && (
                    markerPositions.map((pos, index) => (
                      <div key={`ctrl-${index}`} className="flex items-center gap-3">
                        <div className="w-20 text-sm font-medium text-slate-200">{markerLabels[index]}</div>
                        <input
                          type="number"
                          min={0}
                          max={maxDistance}
                          step={(maxDistance / 4000).toFixed(6)}
                          value={pos.toFixed(3)}
                          onChange={(e) => handleMarkerChange(index, e.target.value)}
                          className="w-24 rounded-md border border-slate-700 bg-slate-950/80 px-2 py-1 text-sm text-white"
                        />
                        <div className="text-xs text-slate-400">km</div>
                      </div>
                    ))
                  )}
                </div>

                <div className="space-y-4">
                  {activeTrace ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {markerLabels.map((label, index) => {
                          const point = metrics?.points[index]
                          return (
                            <div key={label} className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-semibold text-slate-200">{label}</span>
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: markerColors[index] }} />
                              </div>
                              <p className="mt-3 text-sm text-slate-400">{point.distance.toFixed(2)} km</p>
                              <p className="mt-1 text-lg font-semibold text-white">{point.db.toFixed(2)} dBm</p>
                            </div>
                          )
                        })}
                      </div>

                      <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                        <div className="grid gap-4">
                          <div className="flex items-center justify-between text-sm text-slate-400">
                            <span>Distance A to B</span>
                            <span className="font-semibold text-white">{metrics ? `${metrics.deltaX.toFixed(2)} km` : '--'}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm text-slate-400">
                            <span>Loss A-B (4-point)</span>
                            <span className="font-semibold text-white">{metrics ? `${metrics.loss.toFixed(3)} dB` : '--'}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm text-slate-400">
                            <span>Section Attenuation</span>
                            <span className="font-semibold text-white">{metrics ? `${metrics.sectionAttenuation.toFixed(3)} dB/km` : '--'}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                      Marker math will appear once a trace is selected and markers are moved.
                    </div>
                  )}
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}

export default App
