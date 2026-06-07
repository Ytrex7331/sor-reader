import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import Plot from 'react-plotly.js'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { parseSorFile } from './sorParser'
import ReportConfigurator from './ReportConfigurator'

const markerLabels = ['A-Ref', 'A', 'B', 'B-Ref']
const markerColors  = ['#00F5FF', '#FF7A18', '#FF2D95', '#7CFC00']
const palette       = ['#00F5FF', '#7CFC00', '#FF7A18', '#FF2D95', '#A855F7', '#F472B6', '#38BDF8']

// Lightweight decimation helper to prevent DOM layout freezing
function downsampleTraceForReport(traceData, maxPoints = 1200) {
  if (!traceData || traceData.length <= maxPoints) return traceData;

  const step = Math.ceil(traceData.length / maxPoints);
  const sampled = [];

  for (let i = 0; i < traceData.length; i += step) {
    sampled.push(traceData[i]);
  }

  const lastPoint = traceData[traceData.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) {
    sampled.push(lastPoint);
  }

  return sampled;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

// NEW: Universal helper to pull points from either the old or new parser structure
function extractTracePoints(trace) {
  if (!trace) return [];
  // Support the new industry-grade multi-segment structure
  if (trace.dataPoints?.segments) {
    return trace.dataPoints.segments.flatMap(seg => seg.traceData);
  }
  // Fallback for the old parser structure
  return trace.traceData || [];
}

function findNearestPoint(trace, xValue) {
  const pts = extractTracePoints(trace);
  if (pts.length === 0) return { distance: 0, db: 0 }; // Safety fallback

  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid].distance < xValue) lo = mid + 1
    else hi = mid
  }
  const a = pts[Math.max(0, lo - 1)]
  const b = pts[lo]
  if (!b) return a
  return Math.abs(a.distance - xValue) <= Math.abs(b.distance - xValue) ? a : b
}

function calcMarkerMetrics(trace, vals) {
  if (!trace) return null
  const pts   = vals.map((d) => findNearestPoint(trace, d))
  const [aRef, a, b, bRef] = pts
  const dx    = b.distance - a.distance
  const att   = dx > 0 ? (b.db - a.db) / dx : 0
  const dPre  = a.distance - aRef.distance
  const dPost = bRef.distance - b.distance
  const sA    = Math.abs(dPre)  > 1e-9 ? (a.db - aRef.db) / dPre  : 0
  const sB    = Math.abs(dPost) > 1e-9 ? (bRef.db - b.db) / dPost : 0
  const yPreAtB  = a.db + sA * (b.distance - a.distance)
  const yPostAtA = b.db + sB * (a.distance - b.distance)
  const loss  = Math.max(0, 0.5 * ((yPreAtB - b.db) + (a.db - yPostAtA)))
  return { pts, dx, loss, att }
}

function applyRules(prev, idx, raw, max) {
  const p = [...prev]
  const v = Math.max(0, Math.min(raw, max))
  if (idx === 0) {
    p[0] = Math.min(v, p[1])
  } else if (idx === 3) {
    p[3] = Math.max(v, p[2])
  } else if (idx === 1) {
    if (v >= p[2]) {
      const d = v - p[1]
      p[2] = Math.min(p[2] + d, max)
      p[3] = Math.max(p[3], p[2])
    }
    p[1] = v
    if (p[1] < p[0]) p[0] = p[1]
  } else if (idx === 2) {
    if (v <= p[1]) {
      const d = v - p[2]
      p[1] = Math.max(p[1] + d, 0)
      p[0] = Math.min(p[0], p[1])
    }
    p[2] = v
    if (p[2] > p[3]) p[3] = p[2]
  }
  for (let i = 0; i < 4; i++) p[i] = Math.max(0, Math.min(p[i], max))
  return p
}

// ─── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [files,           setFiles]           = useState([])
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set())
  const [uploadError,     setUploadError]     = useState(null)
  const [markerPositions, setMarkerPositions] = useState([2.0, 12.5, 25.8, 30.2])
  const [activeMarker,    setActiveMarker]    = useState(null)
  const [showReport,      setShowReport]      = useState(false)
  const [traceSnapshot,   setTraceSnapshot]   = useState(null)

  const plotRef      = useRef(null)
  const containerRef = useRef(null)
  const svgRef       = useRef(null)
  const groupRefs    = useRef([null, null, null, null])
  const reportRef    = useRef(null)

  // Live refs — updated imperatively, never cause re-renders
  const posRef         = useRef(markerPositions)
  const activeTraceRef = useRef(null)
  const maxRef         = useRef(40)

  useEffect(() => { posRef.current = markerPositions }, [markerPositions])

  // ── Derived ────────────────────────────────────────────────────────────────────
  const selectedTraces = useMemo(() => {
    const sel = []
    selectedFileIds.forEach((id) => {
      const f = files.find((x) => x.id === id)
      if (f) sel.push(f)
    })
    return sel
  }, [files, selectedFileIds])

  const activeTrace = selectedTraces[0] ?? null
  activeTraceRef.current = activeTrace
  
  // FIXED: Using the helper to safely grab the distance
  const activePts = extractTracePoints(activeTrace);
  const maxDistance = activePts.length > 0 ? activePts[activePts.length - 1].distance : 40;
  maxRef.current = maxDistance;

  const metrics = useMemo(
    () => calcMarkerMetrics(activeTrace, markerPositions),
    [activeTrace, markerPositions]
  )

  const handleTriggerReportGeneration = async () => {
    if (!activeTrace) return;

    // 1. Target the underlying Plotly DOM element wrapper
    const graphElement = plotRef.current?.el || document.querySelector('.js-plotly-plot');
    
    if (graphElement && window.Plotly) {
      try {
        // 2. Use Plotly's native export engine instead of html2canvas
        // This forces a standard un-deformed 4:3 or 16:9 ratio regardless of zoom level
        const base64Snapshot = await window.Plotly.toImage(graphElement, {
          format: 'png',
          width: 1200,         // Lock explicit high-definition width
          height: 500,         // Lock explicit high-definition height
          imageDataOnly: false
        });
        
        setTraceSnapshot(base64Snapshot);
      } catch (err) {
        console.error("Plotly native image generation sequence failed:", err);
        
        // Fallback: If Plotly global context isn't globally bound, fallback cleanly to html2canvas
        fallbackHtml2CanvasCapture(graphElement);
      }
    } else {
      // Alternate Fallback
      const liveCanvas = document.querySelector('.js-plotly-plot canvas') || document.querySelector('canvas');
      if (liveCanvas) {
        setTraceSnapshot(liveCanvas.toDataURL('image/png'));
      }
    }

    setShowReport(true);
  };

  // Clean scoped fallback mechanism to avoid rendering lockups
  async function fallbackHtml2CanvasCapture(element) {
    try {
      const canvas = await html2canvas(element, {
        backgroundColor: '#0f172a',
        useCORS: true,
        scale: 2,           // Locks rendering resolution multiplier to negate browser zoom downsampling
        logging: false
      });
      setTraceSnapshot(canvas.toDataURL('image/png', 1.0));
    } catch (e) {
      console.error(e);
    }
  }

  const handlePrint = async (toggles, mode = 'print') => {
    // ─── 1. NATIVE SYSTEM PRINT ENGINE PATH ───
    if (mode === 'print') {
      try {
        document.body.classList.add('printing');
        setTimeout(() => {
          window.print();
          setTimeout(() => document.body.classList.remove('printing'), 500);
        }, 80);
      } catch (e) {
        console.error('Print layout execution failed:', e);
      }
      return;
    }

    // ─── 2. PROFESSIONAL WORD-STYLE PDF VECTOR PATH ───
    if (mode === 'pdf') {
      if (!reportRef.current) return;

      try {
        const targetElement = reportRef.current;

        // Initialize standard A4 Document layout geometry (595.28pt wide x 841.89pt high)
        const pdf = new jsPDF({
          orientation: 'p',
          unit: 'pt',
          format: 'a4',
          compress: true
        });

        // Clear document borders configurations
        const pdfMargin = 36; // Clean 0.5-inch page margin buffers
        const printableWidthPoints = 595.28 - (pdfMargin * 2); 
        const virtualWidthPixels = 794; // Locks desktop baseline resolution layout conversions

        await pdf.html(targetElement, {
          x: pdfMargin,
          y: pdfMargin,
          width: printableWidthPoints,   
          windowWidth: virtualWidthPixels, 
          autoPaging: 'text',             // Keeps line-height font text arrays intact
          
          callback: function (doc) {
            const cleanFileName = `${(activeTrace?.name || 'OTDR_Report').replace(/[^a-z0-9]+/gi, '_')}.pdf`;
            doc.save(cleanFileName);
          },
          
          html2canvas: {
            useCORS: true,
            logging: false,
            backgroundColor: '#ffffff',
            
            onclone: (clonedDocument) => {
              const clonedReport = clonedDocument.querySelector('.printable-report');
              if (clonedReport) {
                // Strip out scrolling layout utility modifiers
                clonedReport.classList.remove('h-full', 'overflow-auto', 'h-screen', 'bg-slate-50');
                
                clonedReport.style.width = `${virtualWidthPixels}px`;
                clonedReport.style.height = 'auto';
                clonedReport.style.maxHeight = 'none';
                clonedReport.style.overflow = 'visible';
                clonedReport.style.position = 'relative';
                clonedReport.style.padding = '0px'; 
                clonedReport.style.backgroundColor = '#ffffff';
                clonedReport.style.color = '#111827';

                // Flatten parent flex layers to allow standard block formatting rules
                const rootFlexWrapper = clonedReport.querySelector('.space-y-6') || clonedReport.children[0];
                if (rootFlexWrapper) {
                  rootFlexWrapper.classList.remove('space-y-6', 'flex', 'flex-col');
                  rootFlexWrapper.style.display = 'block';
                }

                // Flatten multi-column grids to inline-blocks to prevent overflow math bugs
                const gridContainers = clonedReport.querySelectorAll('.grid');
                gridContainers.forEach(grid => {
                  grid.classList.remove('grid', 'grid-cols-2', 'gap-3');
                  grid.style.display = 'block';
                  grid.style.width = '100%';
                  
                  Array.from(grid.children).forEach(child => {
                    child.style.display = 'inline-block';
                    child.style.width = '48%'; 
                    child.style.marginRight = '2%';
                    child.style.verticalAlign = 'top';
                    child.style.marginBottom = '12px';
                    child.style.boxSizing = 'border-box';
                  });
                });

                // ─── HIGH-PRIORITY PRINT STYLE INJECTION (THE FIX) ───
                // This style block forces standard document compiler behaviors across all containers
                const styleTag = clonedDocument.createElement('style');
                styleTag.innerHTML = `
                  /* 1. Force entire component cards/blocks to stay on the same page */
                  .rounded-md, section, .report-chart-wrapper {
                    display: block !important;
                    page-break-inside: avoid !important;
                    break-inside: avoid !important;
                    margin-bottom: 24px !important;
                  }
                  
                  /* 2. Word "Keep with next" simulation: Stops headings from sitting isolated at page bottoms */
                  h1, h2, h3, h4, .text-xs.text-slate-600 {
                    page-break-after: avoid !important;
                    break-after: avoid !important;
                  }

                  /* 3. Force tables to stay in one piece on a page unless they naturally overflow A4 capacity */
                  table {
                    width: 100% !important;
                    table-layout: fixed !important;
                    border-collapse: collapse !important;
                    page-break-inside: avoid !important;
                    break-inside: avoid !important;
                  }

                  /* 4. Protect individual table rows from being sliced in half horizontally */
                  tr {
                    page-break-inside: avoid !important;
                    break-inside: avoid !important;
                  }
                  
                  th, td {
                    padding: 8px !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                  }
                `;
                clonedDocument.head.appendChild(styleTag);
              }
            }
          }
        });

      } catch (error) {
        console.error('Programmatic native jsPDF compilation failed:', error);
      }
    }
  };

  // ── Plotly axis helpers ────────────────────────────────────────────────────────
  const getFL      = ()    => plotRef.current?.el?._fullLayout ?? null
  const d2px       = (v)   => { const fl = getFL(); return fl ? fl.xaxis.l2p(v) + fl.margin.l : null }
  const px2d       = (px)  => { const fl = getFL(); return fl ? fl.xaxis.p2l(px - fl.margin.l) : null }
  const y2px       = (v)   => { const fl = getFL(); return fl ? fl.yaxis.l2p(v) + fl.margin.t : null }
  const getYBounds = ()    => {
    const fl = getFL()
    return fl ? { top: fl.margin.t, bottom: fl.height - fl.margin.b } : { top: 40, bottom: 570 }
  }

  // ── Imperative SVG paint ──────────────────────────────────────────────────────
  const paintOverlay = useCallback((positions) => {
    const pos = positions ?? posRef.current
    const { top, bottom } = getYBounds()
    const totalHeight = bottom - top
    const halfPlotHeight = totalHeight * 0.5

    pos.forEach((v, i) => {
      const g = groupRefs.current[i]
      if (!g) return
      const px = d2px(v)
      if (px === null) return
      const ch = g.children

      const isRefMarker = i === 0 || i === 3
      const [lineTop, lineBottom] = isRefMarker
        ? (() => {
            const trace = activeTraceRef.current
            const point = trace ? findNearestPoint(trace, v) : null
            const yCenter = point ? y2px(point.db) : null
            const centerY = yCenter !== null ? Math.max(top, Math.min(bottom, yCenter)) : top + totalHeight / 2
            return [Math.max(top, centerY - halfPlotHeight / 2), Math.min(bottom, centerY + halfPlotHeight / 2)]
          })()
        : [top, bottom]

      for (let j = 0; j < 2; j++) {
        if (!ch[j]) continue
        ch[j].setAttribute('x1', px)
        ch[j].setAttribute('x2', px)
        ch[j].setAttribute('y1', lineTop)
        ch[j].setAttribute('y2', lineBottom)
      }
      if (ch[2]) {
        ch[2].setAttribute('x', px)
        ch[2].setAttribute('y', lineTop - 6)
      }
    })
  }, [])

  useEffect(() => {
    paintOverlay(markerPositions)
  }, [markerPositions, paintOverlay])

  const handleAfterPlot = useCallback(() => {
    paintOverlay()
  }, [paintOverlay])

  // ── Drag implementation ───────────────────────────────────────────────────────
  const startDrag = useCallback((idx, e) => {
    e.preventDefault()
    e.stopPropagation()
    setActiveMarker(idx)

    groupRefs.current.forEach((g, i) => {
      const line = g?.children[1]
      if (line) line.setAttribute('stroke-width', i === idx ? 4 : 2)
    })

    const onMove = (me) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const dataVal = px2d(me.clientX - rect.left)
      if (dataVal === null) return
      posRef.current = applyRules(posRef.current, idx, dataVal, maxRef.current)
      paintOverlay(posRef.current)
    }

    const onUp = () => {
      setMarkerPositions([...posRef.current])
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [paintOverlay])

  // ── File handling ──────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (incoming) => {
    setUploadError(null)
    const parsed = []
    const failed = []

    for (const file of incoming) {
      try {
        parsed.push(await parseSorFile(file))
      } catch (error) {
        failed.push(`${file.name}: ${error?.message ?? 'invalid or unsupported SOR file'}`)
      }
    }

    if (parsed.length === 0) {
      setUploadError(`Upload failed: ${failed.join('; ')}`)
      return
    }

    if (failed.length > 0) {
      setUploadError(`Some files were skipped: ${failed.join('; ')}`)
    }

    setFiles((cur) => [...cur, ...parsed])
    setSelectedFileIds((cur) => {
      const s = new Set(cur)
      parsed.forEach((f) => s.add(f.id))
      return s
    })
  }, [])

  const handleInputChange = (e) => {
    const f = Array.from(e.target.files || [])
    if (f.length) handleFiles(f)
    e.target.value = ''
  }

  const handleDrop = (e) => {
    e.preventDefault()
    const f = Array.from(e.dataTransfer.files || [])
    if (f.length) handleFiles(f)
  }

  const toggleSelected = (id, e) => {
    e?.stopPropagation()
    setSelectedFileIds((cur) => {
      const s = new Set(cur)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  // FIXED: traceSeries now maps the extracted trace points properly
  const traceSeries = useMemo(() => selectedTraces.map((t, i) => {
    const pts = extractTracePoints(t);
    return {
      x: pts.map((p) => p.distance),
      y: pts.map((p) => p.db),
      type: 'scatter', mode: 'lines', name: t.name,
      line: { color: palette[i % palette.length], width: 1.6 },
      hovertemplate: '%{x:.2f} km<br>%{y:.2f} dB<extra></extra>',
    }
  }), [selectedTraces])

  return (
    <>
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-screen-2xl px-6 py-5">

          <header className="mb-6 flex items-center justify-between rounded-3xl border border-slate-800 bg-slate-900/80 p-5">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-cyan-300">OTDR Analytics Prototype</p>
              <h1 className="mt-2 text-3xl font-semibold text-white">Fiber Trace Review Dashboard</h1>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-300">
              Real SOR parser + live 4-marker analysis
            </div>
          </header>

          <div className="grid gap-6 xl:grid-cols-[320px_1fr]">

            {/* ── Sidebar ── */}
            <aside className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900/90 p-5">
              <div>
                <h2 className="text-lg font-semibold text-white">File Explorer</h2>
                <p className="mt-1 text-sm text-slate-400">Drag .sor / .iolm here or click to select real OTDR trace files.</p>
              </div>

              <div
                className="relative rounded-3xl border-2 border-dashed border-slate-700 bg-slate-950/80 px-4 py-9 text-center transition hover:border-cyan-400"
                onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}
              >
                <input type="file" accept=".sor,.iolm" multiple
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  onChange={handleInputChange} />
                <div className="pointer-events-none">
                  <p className="text-sm font-medium text-slate-100">Drop files here</p>
                  <p className="mt-2 text-xs text-slate-400">or click to select actual .sor/.iolm traces</p>
                </div>
              </div>
              
              {uploadError && (
                <div className="rounded-3xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200">
                  {uploadError}
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">Uploaded Traces</h3>
                  <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">{files.length} total</span>
                </div>
                <div className="mb-3 flex items-center gap-3">
                  <button type="button" onClick={() => setSelectedFileIds(new Set(files.map((f) => f.id)))}
                    className="rounded-full bg-cyan-500/10 px-3 py-1 text-sm font-medium text-cyan-300 ring-1 ring-cyan-500/10 hover:bg-cyan-600/10">
                    Select All
                  </button>
                  <button type="button" onClick={() => setSelectedFileIds(new Set())}
                    className="text-sm text-slate-400 underline-offset-2 hover:underline">
                    Deselect All
                  </button>
                </div>
                <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2">
                  {files.length === 0 ? (
                    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                      No OTDR traces loaded yet.
                    </div>
                  ) : files.map((file) => {
                    const sel = selectedFileIds.has(file.id)
                    return (
                      <div key={file.id} onClick={() => setSelectedFileIds(new Set([file.id]))}
                        className={`flex w-full cursor-pointer items-center justify-between rounded-3xl border px-4 py-3 transition
                          ${sel ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/90 hover:border-slate-600'}`}>
                        <div>
                          <p className="text-sm font-medium text-white">{file.name}</p>
                          <p className="mt-1 text-xs text-slate-400">{file.metadata.wavelength} · {file.metadata.pulseWidth}</p>
                        </div>
                        <label className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={sel} onChange={(e) => toggleSelected(file.id, e)}
                            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-cyan-400 focus:ring-cyan-400" />
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>

              <button 
                type="button"
                onClick={handleTriggerReportGeneration} 
                disabled={selectedTraces.length === 0}
                className={`mt-3 w-full rounded-3xl bg-cyan-600/10 px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] ${selectedTraces.length === 0 ? 'text-slate-500 cursor-not-allowed opacity-50' : 'text-white hover:bg-cyan-600/20'}`}
              >
                Generate Report
              </button>
            </aside>

            {/* ── Main ── */}
            <main className="space-y-6">
              <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-4">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm uppercase tracking-[0.24em] text-cyan-300">Interactive Trace Canvas</p>
                    <h2 className="text-2xl font-semibold text-white">dB vs Distance</h2>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-300">
                    {selectedTraces.length > 0
                      ? `${selectedTraces.length} trace${selectedTraces.length > 1 ? 's' : ''} overlayed`
                      : 'Select a trace to render'}
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
                          xaxis: { title: { text: 'Distance (km)' }, gridcolor: '#334155', zerolinecolor: '#334155' },
                          yaxis: { title: { text: 'Signal Level (dBm)' }, gridcolor: '#334155', zerolinecolor: '#334155' },
                          dragmode: 'zoom',
                          hovermode: 'closest',
                          legend: { orientation: 'v', x: 0.98, xanchor: 'right', y: 0.98, bgcolor: 'rgba(0,0,0,0)', font: { size: 12 } },
                          showlegend: true,
                        }}
                        style={{ width: '100%', height: '100%' }}
                        config={{ responsive: true, displayModeBar: true, editable: false }}
                        onAfterPlot={handleAfterPlot}
                        onRelayout={handleAfterPlot}
                      />

                      <svg
                        ref={svgRef}
                        style={{
                          position: 'absolute', top: 0, left: 0,
                          width: '100%', height: '100%',
                          overflow: 'visible',
                          pointerEvents: 'none',
                        }}
                      >
                        {markerLabels.map((label, i) => (
                          <g
                            key={i}
                            ref={(el) => { groupRefs.current[i] = el }}
                            style={{ pointerEvents: 'all' }}
                          >
                            <line x1="0" x2="0" y1="0" y2="0"
                              stroke="transparent" strokeWidth={14}
                              style={{ cursor: 'ew-resize' }}
                              onMouseDown={(e) => startDrag(i, e)}
                            />
                            <line x1="0" x2="0" y1="0" y2="0"
                              stroke={markerColors[i]}
                              strokeWidth={activeMarker === i ? 4 : 2}
                              strokeDasharray="6 4"
                              style={{ pointerEvents: 'none' }}
                            />
                            <text x="0" y="0"
                              fill={markerColors[i]}
                              fontSize={12} fontWeight="600" textAnchor="middle"
                              fontFamily="Inter, system-ui, sans-serif"
                              style={{ pointerEvents: 'none', userSelect: 'none' }}
                            >
                              {label}
                            </text>
                          </g>
                        ))}
                      </svg>
                    </div>
                  )}
                </div>
              </section>

              <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                {/* Metadata */}
                <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
                  <h3 className="mb-1 text-xl font-semibold text-white">Trace Metadata</h3>
                  <p className="mb-5 text-sm text-slate-400">Realtime fiber parameters from the selected mock trace.</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {activeTrace ? Object.entries(activeTrace.metadata).map(([k, v]) => (
                      <div key={k} className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{k.replace(/([A-Z])/g, ' $1')}</p>
                        <p className="mt-2 text-lg font-semibold text-white">{v}</p>
                      </div>
                    )) : (
                      <div className="col-span-2 rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                        Select a trace to inspect metadata and event metrics.
                      </div>
                    )}
                  </div>
                </div>

                {/* Marker readout */}
                <div className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
                  {activeTrace ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {markerLabels.map((label, i) => {
                          const pt = metrics?.pts[i]
                          return (
                            <div key={label} className="rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-semibold text-slate-200">{label}</span>
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: markerColors[i] }} />
                              </div>
                              <p className="mt-3 text-sm text-slate-400">{pt.distance.toFixed(2)} km</p>
                              <p className="mt-1 text-lg font-semibold text-white">{pt.db.toFixed(2)} dBm</p>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-4 rounded-3xl border border-slate-800 bg-slate-950/80 p-4">
                        <div className="grid gap-4">
                          {[
                            ['Distance A to B',    metrics ? `${metrics.dx.toFixed(2)} km`   : '--'],
                            ['Loss A-B (4-point)',  metrics ? `${metrics.loss.toFixed(3)} dB` : '--'],
                            ['Section Attenuation', metrics ? `${metrics.att.toFixed(3)} dB/km` : '--'],
                          ].map(([label, val]) => (
                            <div key={label} className="flex items-center justify-between text-sm text-slate-400">
                              <span>{label}</span>
                              <span className="font-semibold text-white">{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/80 p-6 text-center text-slate-500">
                      Marker math will appear once a trace is selected and markers are moved.
                    </div>
                  )}
                </div>
              </section>
            </main>
          </div>
        </div>
        
        <ReportConfigurator
          visible={showReport}
          activeTrace={activeTrace}
          metrics={metrics}
          snapshotImg={traceSnapshot}
          reportRef={reportRef}
          onClose={() => setShowReport(false)}
          onPrint={handlePrint}
        />
      </div>                
    </>
  )
}