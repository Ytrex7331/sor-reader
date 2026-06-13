import { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import Plot from 'react-plotly.js'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { parseSorFile } from './sorParser'
import ReportConfigurator from './ReportConfigurator'
import { calculateLSALoss, classifyEventType, getDynamicThreshold, createEventFromCursor, updateEventClassification } from './traceAnalysis'

const markerLabels = ['A-Ref', 'A', 'B', 'B-Ref']
const markerColors  = ['#4a9eff', '#ff7a18', '#ff2d95', '#7cfc00']
const palette       = ['#4a9eff', '#7cfc00', '#ff7a18', '#ff2d95', '#A855F7', '#F472B6', '#38BDF8']

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

function leastSquaresLine(pts) {
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of pts) {
    sx  += p.distance;
    sy  += p.db;
    sxy += p.distance * p.db;
    sx2 += p.distance * p.distance;
  }
  const denom = n * sx2 - sx * sx;
  if (Math.abs(denom) < 1e-10) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function calcMarkerMetrics(trace, vals) {
  if (!trace) return null
  const tracePts = extractTracePoints(trace)
  if (!tracePts || tracePts.length === 0) return null

  const pts = vals.map((d) => findNearestPoint(trace, d))
  const [aRef, a, b, bRef] = pts
  
  const dx = b.distance - a.distance
  const loss2pt = a.db - b.db
  const att = dx > 0 ? loss2pt / dx : 0

  const prePts = tracePts.filter(p => p.distance > aRef.distance && p.distance < a.distance)
  const postPts = tracePts.filter(p => p.distance > b.distance && p.distance < bRef.distance)

  const pre = leastSquaresLine(prePts)
  const post = leastSquaresLine(postPts)

  let s1 = null, b1 = null, s2 = null, b2 = null, loss = 0
  if (pre && post) {
    s1 = pre.slope
    b1 = pre.intercept
    s2 = post.slope
    b2 = post.intercept
    const preAtA = s1 * a.distance + b1
    const postAtA = s2 * a.distance + b2
    loss = Math.max(0, preAtA - postAtA)
  }

  return { pts, dx, loss, att, loss2pt, s1, b1, s2, b2 }
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
  
  // Interactive trace state: draggable cursors and editable events
  const [cursorA, setCursorA] = useState(5.0)
  const [cursorB, setCursorB] = useState(15.0)
  const [activeCursor, setActiveCursor] = useState(null)
  const [traceEvents, setTraceEvents] = useState([])
  const [contextMenu, setContextMenu] = useState(null)

  const plotRef        = useRef(null)
  const containerRef   = useRef(null)
  const svgRef         = useRef(null)
  const groupRefs      = useRef([null, null, null, null])
  const cursorRefs     = useRef([null, null]) // Refs for cursor A and B SVG groups
  const reportRef      = useRef(null)

  // Live refs — updated imperatively, never cause re-renders
  const posRef         = useRef(markerPositions)
  const activeTraceRef = useRef(null)
  const maxRef         = useRef(40)
  const cursorARef     = useRef(cursorA)
  const cursorBRef     = useRef(cursorB)

  useEffect(() => { posRef.current = markerPositions }, [markerPositions])
  useEffect(() => { cursorARef.current = cursorA; cursorBRef.current = cursorB }, [cursorA, cursorB])

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
  const activePts = extractTracePoints(activeTrace)
  const maxDistance = activePts.length > 0 ? activePts[activePts.length - 1].distance : 40
  maxRef.current = maxDistance

  // Initialize cursors to 30% and 70% of the trace distance when trace changes
  useEffect(() => {
    if (maxDistance > 0) {
      setCursorA(maxDistance * 0.3)
      setCursorB(maxDistance * 0.7)
    }
  }, [maxDistance])

  const metrics = useMemo(
    () => calcMarkerMetrics(activeTrace, markerPositions),
    [activeTrace, markerPositions]
  )

  // Distance unit helpers for dashboard
  const fixed = activeTrace?.fixed || {}
  const unitsOfDistance = fixed.unitsOfDistance === 'mt' ? 'm' : 'km'
  const distanceScale = unitsOfDistance === 'm' ? 1000 : 1
  const formatDistanceValue = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return `${(Number(value) * distanceScale).toFixed(unitsOfDistance === 'm' ? 1 : 4)}`
  }

  // Initialize trace events from active trace when it changes
  // (Now placed AFTER activeTrace is defined)
  useEffect(() => {
    if (activeTrace?.keyEvents?.events) {
      const rawEvents = Array.isArray(activeTrace.keyEvents.events) ? activeTrace.keyEvents.events : []
      const initEvents = rawEvents.map((ev) => {
        const spliceLossValue = Number(ev.spliceLoss) || 0
        const reflectanceValue = Number(ev.reflectance) || 0
        const eventType = classifyEventType(spliceLossValue, reflectanceValue)
        const threshold = getDynamicThreshold(eventType)
        return {
          id: `${ev.eventNumber}-${Math.random()}`,
          eventNumber: ev.eventNumber ?? '--',
          distanceKm: ev.distanceKm ?? ev.distance ?? 0,
          spliceLossValue,
          spliceLoss: spliceLossValue.toFixed(3),
          reflectanceValue,
          reflectance: reflectanceValue.toFixed(3),
          eventCode: ev.eventCode ?? '--',
          lossTech: ev.lossTech ?? '--',
          comment: ev.comment ?? '',
          eventType,
          isFlagged: spliceLossValue > threshold,
          isLastEvent: ev.isLastEvent ?? false,
          isUserAdded: false
        }
      })
      setTraceEvents(initEvents)
    } else {
      setTraceEvents([])
    }
  }, [activeTrace])

  // ── Event Handlers for Interactive Trace ───────────────────────────────────
  
  const handleAddEventAtCursor = useCallback((cursorDistance, cursorName) => {
    if (!activeTrace) return
    
    const tracePoints = extractTracePoints(activeTrace)
    const newEvent = createEventFromCursor(cursorDistance, tracePoints, -99, traceEvents.length + 1)
    newEvent.id = `${cursorName}-${Math.random()}`
    
    setTraceEvents(prev => [...prev, newEvent])
    setContextMenu(null)
  }, [activeTrace, traceEvents.length])
  
  const handleDeleteEvent = useCallback((eventId) => {
    setTraceEvents(prev => prev.filter(e => e.id !== eventId))
    setContextMenu(null)
  }, [])
  
  const handleUpdateEventClassification = useCallback((eventId, newEventType) => {
    setTraceEvents(prev => prev.map(e => 
      e.id === eventId ? updateEventClassification(e, newEventType) : e
    ))
  }, [])
  
  const handleCursorDragStart = useCallback((cursorName) => {
    setActiveCursor(cursorName)
  }, [])
  
  const handleCursorDrag = useCallback((cursorName, newDistance) => {
    const clamped = Math.max(0, Math.min(newDistance, maxRef.current))
    if (cursorName === 'A') setCursorA(clamped)
    else if (cursorName === 'B') setCursorB(clamped)
  }, [])
  
  const handleCursorContextMenu = useCallback((e, cursorName) => {
    e.preventDefault()
    const cursor = cursorName === 'A' ? cursorA : cursorB
    setContextMenu({
      type: 'cursor',
      cursor: cursorName,
      distance: cursor,
      x: e.clientX,
      y: e.clientY
    })
  }, [cursorA, cursorB])
  
  const handleEventContextMenu = useCallback((e, eventId) => {
    e.preventDefault()
    setContextMenu({
      type: 'event',
      eventId,
      x: e.clientX,
      y: e.clientY
    })
  }, [])

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
  const paintOverlay = useCallback((positions, cursors) => {
    const pos = positions ?? posRef.current
    const { top, bottom } = getYBounds()
    const totalHeight = bottom - top
    const halfPlotHeight = totalHeight * 0.5

    // Paint markers (A-Ref, A, B, B-Ref)
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

    // Paint cursors (A and B)
    const cursorValues = cursors ?? [cursorARef.current, cursorBRef.current]
    
    cursorValues.forEach((v, i) => {
      const g = cursorRefs.current[i]
      if (!g) return
      const px = d2px(v)
      if (px === null) return
      
      const children = g.children
      // children[0] = transparent hit-target line
      // children[1] = visible colored line
      // children[2] = text label
      if (children[1]) { // visible line
        children[1].setAttribute('x1', px)
        children[1].setAttribute('x2', px)
        children[1].setAttribute('y1', top)
        children[1].setAttribute('y2', bottom)
      }
      if (children[2]) { // text label
        children[2].setAttribute('x', px)
        children[2].setAttribute('y', bottom + 18)
      }
    })
  }, [])

  useEffect(() => {
    paintOverlay(markerPositions, [cursorARef.current, cursorBRef.current])
  }, [markerPositions, paintOverlay])

  // Paint cursors when they change (using useLayoutEffect to paint after render)
  useLayoutEffect(() => {
    if (cursorRefs.current[0] && cursorRefs.current[1]) {
      paintOverlay(markerPositions, [cursorA, cursorB])
    }
  }, [cursorA, cursorB, paintOverlay, markerPositions])

  const handleAfterPlot = useCallback(() => {
    // Ensure both markers and cursors are painted after plot renders
    paintOverlay(markerPositions, [cursorARef.current, cursorBRef.current])
  }, [paintOverlay, markerPositions])

  // ── Drag implementation for markers ───────────────────────────────────────────
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
      // Update state so React knows about the change
      setMarkerPositions([...posRef.current])
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [])

  // ── Drag implementation for cursors ────────────────────────────────────────────
  const startCursorDrag = useCallback((cursorIdx, e) => {
    e.preventDefault()
    e.stopPropagation()
    setActiveCursor(cursorIdx === 0 ? 'A' : 'B')

    cursorRefs.current.forEach((g, i) => {
      const line = g?.children[0]
      if (line) line.setAttribute('stroke-width', i === cursorIdx ? 3 : 2)
    })

    const onMove = (me) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const dataVal = px2d(me.clientX - rect.left)
      if (dataVal === null) return
      const clamped = Math.max(0, Math.min(dataVal, maxRef.current))
      
      // Update refs immediately for paintOverlay
      if (cursorIdx === 0) {
        cursorARef.current = clamped
        setCursorA(clamped)  // Update state so React knows about the change
      } else {
        cursorBRef.current = clamped
        setCursorB(clamped)  // Update state so React knows about the change
      }
    }

    const onUp = () => {
      setActiveCursor(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [])

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

  const lsaShapes = useMemo(() => {
    if (!activeTrace || !metrics) return []
    const { pts, s1, b1, s2, b2 } = metrics
    const [pAref, pA, pB, pBref] = pts
    const shapes = []

    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper',
      x0: pAref.distance, y0: 0, x1: pA.distance, y1: 1,
      fillcolor: 'rgba(74,158,255,0.07)',
      line: { color: 'rgba(74,158,255,0.25)', dash: 'dot', width: 1 }
    })

    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper',
      x0: pB.distance, y0: 0, x1: pBref.distance, y1: 1,
      fillcolor: 'rgba(124,252,0,0.06)',
      line: { color: 'rgba(124,252,0,0.2)', dash: 'dot', width: 1 }
    })

    if (s1 !== null) {
      const x0 = pAref.distance
      const x1 = Math.min(pB.distance, pA.distance + (pA.distance - pAref.distance) * 0.8)
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: x0, y0: s1 * x0 + b1, x1: x1, y1: s1 * x1 + b1,
        line: { color: 'rgba(74,158,255,0.5)', dash: 'dashdot', width: 1.5 }
      })
    }

    if (s2 !== null) {
      const x0 = Math.max(pA.distance, pB.distance - (pBref.distance - pB.distance) * 0.8)
      const x1 = pBref.distance
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: x0, y0: s2 * x0 + b2, x1: x1, y1: s2 * x1 + b2,
        line: { color: 'rgba(124,252,0,0.5)', width: 1.5 }
      })
    }

    if (s1 !== null && s2 !== null) {
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: pA.distance, y0: s1 * pA.distance + b1, x1: pA.distance, y1: s2 * pA.distance + b2,
        line: { color: 'rgba(255,255,255,0.25)', dash: 'dot', width: 1 }
      })
    }

    return shapes
  }, [activeTrace, metrics])

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
                          shapes: lsaShapes,
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
                        {/* Markers: A-Ref, A, B, B-Ref */}
                        {markerLabels.map((label, i) => {
                          const isRef = i === 0 || i === 3;
                          return (
                          <g
                            key={i}
                            ref={(el) => { groupRefs.current[i] = el }}
                            style={{ pointerEvents: 'all' }}
                          >
                            <line x1="0" x2="0" y1="0" y2="0"
                              stroke="transparent" strokeWidth={18}
                              style={{ cursor: 'ew-resize' }}
                              onMouseDown={(e) => startDrag(i, e)}
                            />
                            <line x1="0" x2="0" y1="0" y2="0"
                              stroke={markerColors[i]}
                              strokeWidth={isRef ? 1 : 1.5}
                              strokeDasharray={isRef ? "5 4" : "none"}
                              opacity={isRef ? 0.5 : 0.85}
                              style={{ pointerEvents: 'none' }}
                            />
                            <text x="0" y="0"
                              fill={markerColors[i]}
                              fontSize={isRef ? 9 : 11} fontWeight={isRef ? 400 : 600} textAnchor="middle"
                              fontFamily="Inter, system-ui, sans-serif"
                              opacity={isRef ? 0.7 : 1}
                              style={{ pointerEvents: 'none', userSelect: 'none' }}
                            >
                              {label}
                            </text>
                          </g>
                        )})}

                        {/* Cursors: A and B */}
                        {['A', 'B'].map((label, i) => {
                          const colors = ['#60a5fa', '#ec4899']
                          const defaultX = i === 0 ? 100 : 300 // Initial placeholder positions
                          return (
                          <g
                            key={`cursor-${i}`}
                            ref={(el) => { cursorRefs.current[i] = el }}
                            style={{ pointerEvents: 'all' }}
                          >
                            <line x1={defaultX} x2={defaultX} y1="0" y2="600"
                              stroke="transparent" strokeWidth={16}
                              style={{ cursor: 'ew-resize' }}
                              onMouseDown={(e) => startCursorDrag(i, e)}
                            />
                            <line x1={defaultX} x2={defaultX} y1="0" y2="600"
                              stroke={colors[i]}
                              strokeWidth={2}
                              opacity={0.7}
                              style={{ pointerEvents: 'none' }}
                            />
                            <text x={defaultX} y="620"
                              fill={colors[i]}
                              fontSize={10} fontWeight={500} textAnchor="middle"
                              fontFamily="Inter, system-ui, sans-serif"
                              opacity={0.9}
                              style={{ pointerEvents: 'none', userSelect: 'none' }}
                            >
                              {label}
                            </text>
                          </g>
                        )})}
                      </svg>
                    </div>
                  )}
                </div>

                {/* --- LSA Legend & Metrics (Matched to target HTML layout) --- */}
                {metrics && (
                  <div className="mt-4 rounded-3xl border border-slate-800 bg-slate-950/80 p-4 space-y-4">
                    
                    {/* Legend */}
                    <div className="flex flex-wrap items-center gap-6 px-2 text-xs text-slate-400">
                      <div className="flex items-center gap-2">
                        <div className="w-5 border-t-2 border-dashed border-[#4a9eff] opacity-70"></div>
                        <span>A-Ref (LSA pre)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-0.5 w-5 bg-[#ff7a18]"></div>
                        <span>A (event start)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-0.5 w-5 bg-[#ff2d95]"></div>
                        <span>B (event end)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-5 border-t-2 border-dashed border-[#7cfc00] opacity-70"></div>
                        <span>B-Ref (LSA post)</span>
                      </div>
                      <div className="flex items-center gap-2 ml-auto">
                        <div className="h-2.5 w-5 rounded-sm border border-[#4a9eff]/30 bg-[#4a9eff]/10"></div>
                        <span>LSA region</span>
                      </div>
                    </div>

                    {/* Metrics Grid */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-[1px] bg-slate-800 rounded-xl overflow-hidden">
                      <div className="bg-slate-950 p-4">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">A distance</div>
                        <div className="text-lg font-medium tabular-nums text-[#58a6ff]">{metrics.pts[1].distance.toFixed(3)} km</div>
                      </div>
                      <div className="bg-slate-950 p-4">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">B distance</div>
                        <div className="text-lg font-medium tabular-nums text-[#58a6ff]">{metrics.pts[2].distance.toFixed(3)} km</div>
                      </div>
                      <div className="bg-slate-950 p-4">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">ΔA→B</div>
                        <div className="text-lg font-medium tabular-nums text-slate-200">{metrics.dx.toFixed(3)} km</div>
                      </div>
                      <div className="bg-slate-950 p-4">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">2-Point Loss</div>
                        <div className="text-lg font-medium tabular-nums text-[#d29922]">{metrics.loss2pt.toFixed(3)} dB</div>
                      </div>
                    </div>

                    {/* LSA Panel Cards */}
                    <div className="grid lg:grid-cols-2 gap-4">
                      {/* Card 1 */}
                      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                        <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-widest text-slate-400">
                          <span className="h-2 w-2 rounded-full bg-[#58a6ff]"></span>
                          Section attenuation
                        </div>
                        <div className="space-y-2">
                          <div className="flex justify-between border-b border-slate-800 pb-2 text-xs">
                            <span className="text-slate-400">Loss A→B (2-point)</span>
                            <span className="font-medium text-slate-200 tabular-nums">{metrics.loss2pt.toFixed(3)} dB</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-800 pb-2 text-xs">
                            <span className="text-slate-400">Attenuation</span>
                            <span className="font-medium text-slate-200 tabular-nums">{metrics.att.toFixed(4)} dB/km</span>
                          </div>
                          <div className="flex justify-between pb-1 text-xs">
                            <span className="text-slate-400">Span (A→B)</span>
                            <span className="font-medium text-slate-200 tabular-nums">{metrics.dx.toFixed(3)} km</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Card 2 */}
                      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
                        <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-widest text-slate-400">
                          <span className="h-2 w-2 rounded-full bg-[#3fb950]"></span>
                          4-Point LSA splice loss
                        </div>
                        <div className="space-y-2">
                          <div className="flex justify-between border-b border-slate-800 pb-2 text-xs">
                            <span className="text-slate-400">Pre-event slope</span>
                            <span className="font-medium text-slate-200 tabular-nums">{metrics.s1 !== null ? (metrics.s1 * 1000).toFixed(2) + ' dB/km (pre)' : '— (need more data)'}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-800 pb-2 text-xs">
                            <span className="text-slate-400">Post-event slope</span>
                            <span className="font-medium text-slate-200 tabular-nums">{metrics.s2 !== null ? (metrics.s2 * 1000).toFixed(2) + ' dB/km (post)' : '—'}</span>
                          </div>
                          <div className="pt-1">
                            <div className={"text-2xl font-medium tabular-nums " + (metrics.loss > 0.5 ? "text-[#f85149]" : "text-[#3fb950]")}>
                              {metrics.s1 !== null ? metrics.loss.toFixed(3) + ' dB' : '—'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Interactive Trace Event Controls */}
              {activeTrace && (
                <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-6">
                  <h3 className="mb-4 text-xl font-semibold text-white">Trace Event Editor</h3>
                  
                  {/* Cursor Controls */}
                  <div className="mb-6 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-sm font-semibold text-slate-300">Cursor A (Reference)</label>
                        <span className="rounded-full bg-blue-500/20 px-2 py-1 text-xs font-mono text-blue-300">{(cursorA * distanceScale).toFixed(2)} {unitsOfDistance}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={maxDistance}
                        step="0.1"
                        value={cursorA}
                        onChange={(e) => setCursorA(parseFloat(e.target.value))}
                        className="w-full"
                      />
                      <button
                        onClick={() => handleAddEventAtCursor(cursorA, 'A')}
                        className="mt-3 w-full rounded-lg bg-blue-500/30 px-3 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-500/40"
                      >
                        + Add Event at Cursor A
                      </button>
                    </div>

                    <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-sm font-semibold text-slate-300">Cursor B (Measurement)</label>
                        <span className="rounded-full bg-pink-500/20 px-2 py-1 text-xs font-mono text-pink-300">{(cursorB * distanceScale).toFixed(2)} {unitsOfDistance}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={maxDistance}
                        step="0.1"
                        value={cursorB}
                        onChange={(e) => setCursorB(parseFloat(e.target.value))}
                        className="w-full"
                      />
                      <button
                        onClick={() => handleAddEventAtCursor(cursorB, 'B')}
                        className="mt-3 w-full rounded-lg bg-pink-500/30 px-3 py-2 text-sm font-semibold text-pink-200 hover:bg-pink-500/40"
                      >
                        + Add Event at Cursor B
                      </button>
                    </div>
                  </div>

                  {/* Events Table */}
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/80 overflow-hidden">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-950 text-left text-xs uppercase tracking-wider text-slate-400">
                        <tr>
                          <th className="px-4 py-3">#</th>
                          <th className="px-4 py-3">Distance</th>
                          <th className="px-4 py-3">Loss (dB)</th>
                          <th className="px-4 py-3">Reflectance (dB)</th>
                          <th className="px-4 py-3">Type</th>
                          <th className="px-4 py-3">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {traceEvents.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-4 text-center text-slate-500">
                              No events added. Use cursors above to add events.
                            </td>
                          </tr>
                        ) : (
                          traceEvents.map((event) => (
                            <tr key={event.id} className={`${event.isFlagged ? 'bg-rose-500/10' : 'hover:bg-slate-800/50'}`}>
                              <td className="px-4 py-3 font-mono text-slate-300">{event.eventNumber}</td>
                              <td className="px-4 py-3 font-mono text-slate-300">{formatDistanceValue(event.distanceKm)} {unitsOfDistance}</td>
                              <td className={`px-4 py-3 font-mono ${event.isFlagged ? 'text-rose-400 font-semibold' : 'text-slate-300'}`}>{event.spliceLoss}</td>
                              <td className="px-4 py-3 font-mono text-slate-400">{event.reflectance}</td>
                              <td className="px-4 py-3">
                                <select
                                  value={event.eventType || 'splice'}
                                  onChange={(e) => handleUpdateEventClassification(event.id, e.target.value)}
                                  className="rounded px-2 py-1 text-xs border border-slate-700 bg-slate-900 text-slate-200"
                                >
                                  <option value="splice">Splice</option>
                                  <option value="connector">Connector</option>
                                  <option value="splitter">Splitter</option>
                                </select>
                              </td>
                              <td className="px-4 py-3">
                                {event.isUserAdded && (
                                  <button
                                    onClick={() => handleDeleteEvent(event.id)}
                                    className="rounded px-2 py-1 text-xs bg-rose-500/30 text-rose-300 hover:bg-rose-500/50"
                                  >
                                    Delete
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

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