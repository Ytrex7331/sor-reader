import sys
with open('src/App.jsx', 'r') as f: content = f.read()
def esc(s): return s.replace('BACKTICK', chr(96))

old_shapes = '''    shapes.push({
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
    }'''

new_shapes = '''    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper',
      x0: pAref.distance * distanceScale, y0: 0, x1: pA.distance * distanceScale, y1: 1,
      fillcolor: 'rgba(74,158,255,0.07)',
      line: { color: 'rgba(74,158,255,0.25)', dash: 'dot', width: 1 }
    })

    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper',
      x0: pB.distance * distanceScale, y0: 0, x1: pBref.distance * distanceScale, y1: 1,
      fillcolor: 'rgba(124,252,0,0.06)',
      line: { color: 'rgba(124,252,0,0.2)', dash: 'dot', width: 1 }
    })

    if (s1 !== null) {
      const x0 = pAref.distance
      const x1 = Math.min(pB.distance, pA.distance + (pA.distance - pAref.distance) * 0.8)
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: x0 * distanceScale, y0: s1 * x0 + b1, x1: x1 * distanceScale, y1: s1 * x1 + b1,
        line: { color: 'rgba(74,158,255,0.5)', dash: 'dashdot', width: 1.5 }
      })
    }

    if (s2 !== null) {
      const x0 = Math.max(pA.distance, pB.distance - (pBref.distance - pB.distance) * 0.8)
      const x1 = pBref.distance
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: x0 * distanceScale, y0: s2 * x0 + b2, x1: x1 * distanceScale, y1: s2 * x1 + b2,
        line: { color: 'rgba(124,252,0,0.5)', width: 1.5 }
      })
    }

    if (s1 !== null && s2 !== null) {
      shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: pA.distance * distanceScale, y0: s1 * pA.distance + b1, x1: pA.distance * distanceScale, y1: s2 * pA.distance + b2,
        line: { color: 'rgba(255,255,255,0.25)', dash: 'dot', width: 1 }
      })
    }'''
content = content.replace(old_shapes, new_shapes)

reps = [
  ("xaxis: { title: { text: 'Distance (km)' }", "xaxis: { title: { text: BACKTICKDistance (${unitsOfDistance})BACKTICK }"),
  ("{metrics.pts[1].distance.toFixed(3)} km", "{formatDistanceValue(metrics.pts[1].distance, 3)} {unitsOfDistance}"),
  ("{metrics.pts[2].distance.toFixed(3)} km", "{formatDistanceValue(metrics.pts[2].distance, 3)} {unitsOfDistance}"),
  ("{metrics.dx.toFixed(3)} km", "{formatDistanceValue(metrics.dx, 3)} {unitsOfDistance}"),
  ("{metrics.att.toFixed(4)} dB/km", "{unitInfo.isKm ? metrics.att.toFixed(4) : (metrics.att / distanceScale).toFixed(unitInfo.attDecimals)} dB/{unitsOfDistance}"),
  ("{metrics.s1 !== null ? (metrics.s1 * 1000).toFixed(2) + ' dB/km (pre)' : '— (need more data)'}", "{metrics.s1 !== null ? (unitInfo.isKm ? (metrics.s1 * 1000).toFixed(2) : (metrics.s1 * 1000 / distanceScale).toFixed(unitInfo.attDecimals)) + BACKTICK dB/${unitsOfDistance} (pre)BACKTICK : '— (need more data)'}"),
  ("{metrics.s2 !== null ? (metrics.s2 * 1000).toFixed(2) + ' dB/km (post)' : '—'}", "{metrics.s2 !== null ? (unitInfo.isKm ? (metrics.s2 * 1000).toFixed(2) : (metrics.s2 * 1000 / distanceScale).toFixed(unitInfo.attDecimals)) + BACKTICK dB/${unitsOfDistance} (post)BACKTICK : '—'}"),
  ("{pt.distance.toFixed(2)} km", "{formatDistanceValue(pt.distance, 2)} {unitsOfDistance}"),
  ("['Distance A to B',    metrics ? BACKTICK${metrics.dx.toFixed(2)} kmBACKTICK   : '--'],", "['Distance A to B',    metrics ? BACKTICK${formatDistanceValue(metrics.dx, 2)} ${unitsOfDistance}BACKTICK   : '--'],"),
  ("['Section Attenuation', metrics ? BACKTICK${metrics.att.toFixed(3)} dB/kmBACKTICK : '--'],", "['Section Attenuation', metrics ? BACKTICK${unitInfo.isKm ? metrics.att.toFixed(3) : (metrics.att / distanceScale).toFixed(unitInfo.attDecimals)} dB/${unitsOfDistance}BACKTICK : '--'],"),
  (">Distance (km)<", ">Distance ({unitsOfDistance})<"),
  ("{event.distanceKm.toFixed(4)}", "{formatDistanceValue(event.distanceKm, 4)}")
]
for o, n in reps: content = content.replace(esc(o), esc(n))
with open('src/App.jsx', 'w') as f: f.write(content)
