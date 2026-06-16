import re
with open('src/App.jsx', 'r') as f:
    content = f.read()

old_helpers = '''  // Distance unit helpers for dashboard
  const fixed = activeTrace?.fixed || {}
  const unitsOfDistance = fixed.unitsOfDistance === 'mt' ? 'm' : 'km'
  const distanceScale = unitsOfDistance === 'm' ? 1000 : 1
  const formatDistanceValue = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return `${(Number(value) * distanceScale).toFixed(unitsOfDistance === 'm' ? 1 : 4)}`
  }'''
new_helpers = '''  // Distance unit helpers for dashboard
  const fixed = activeTrace?.fixed || {}
  
  const getUnitInfo = (unitCode) => {
    switch (unitCode) {
      case 'mt': return { label: 'm', scale: 1000, decimals: 1, attDecimals: 4, isKm: false };
      case 'ft': return { label: 'ft', scale: 3280.84, decimals: 1, attDecimals: 5, isKm: false };
      case 'kf': return { label: 'kft', scale: 3.28084, decimals: 3, attDecimals: 4, isKm: false };
      case 'mi': return { label: 'mi', scale: 0.621371, decimals: 4, attDecimals: 4, isKm: false };
      case 'km':
      default: return { label: 'km', scale: 1, decimals: 4, attDecimals: 4, isKm: true };
    }
  }
  const unitInfo = getUnitInfo(fixed.unitsOfDistance);
  const unitsOfDistance = unitInfo.label;
  const distanceScale = unitInfo.scale;
  const formatDistanceValue = (value, fractionDigits = unitInfo.decimals) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return `${(Number(value) * distanceScale).toFixed(fractionDigits)}`
  }'''
content = content.replace(old_helpers.replace('`', '`'), new_helpers.replace('`', '`'))

old_trace = '''  // FIXED: traceSeries now maps the extracted trace points properly
  const traceSeries = useMemo(() => selectedTraces.map((t, i) => {
    const pts = extractTracePoints(t);
    return {
      x: pts.map((p) => p.distance),
      y: pts.map((p) => p.db),
      type: 'scatter', mode: 'lines', name: t.name,
      line: { color: palette[i % palette.length], width: 1.6 },
      hovertemplate: '%{x:.2f} km<br>%{y:.2f} dB<extra></extra>',
    }
  }), [selectedTraces])'''
new_trace = '''  // FIXED: traceSeries now maps the extracted trace points properly
  const traceSeries = useMemo(() => selectedTraces.map((t, i) => {
    const pts = extractTracePoints(t);
    const traceUnitInfo = getUnitInfo(t.fixed?.unitsOfDistance);
    return {
      x: pts.map((p) => p.distance * traceUnitInfo.scale),
      y: pts.map((p) => p.db),
      type: 'scatter', mode: 'lines', name: t.name,
      line: { color: palette[i % palette.length], width: 1.6 },
      hovertemplate: `%{x:.2f} ${traceUnitInfo.label}<br>%{y:.2f} dB<extra></extra>`,
    }
  }), [selectedTraces])'''
content = content.replace(old_trace, new_trace)

with open('src/App.jsx', 'w') as f:
    f.write(content)
