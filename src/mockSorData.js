export function generateMockSorData(fileName) {
  const wavelength = Math.random() < 0.55 ? 1550 : 1310
  const pulseWidths = wavelength === 1550 ? [50, 100, 200, 500] : [100, 200, 300, 500]
  const pulseWidth = pulseWidths[Math.floor(Math.random() * pulseWidths.length)]
  const pulseDuration = `${pulseWidth} ns`
  const rangeKm = 40
  const points = 4000
  const slope = wavelength === 1550 ? 0.2 : 0.35
  const fiberCoefficient = Number((slope + (Math.random() * 0.02 - 0.01)).toFixed(3))
  const startLevel = 26 + Math.random() * 2
  const traceData = []

  for (let index = 0; index < points; index += 1) {
    const distance = (index * rangeKm) / (points - 1)
    const baseCurve = startLevel - slope * distance
    const noise = (Math.random() - 0.5) * 0.1
    traceData.push({ distance, db: Number((baseCurve + noise).toFixed(3)) })
  }

  // Launch reflection peak
  if (traceData.length > 1) {
    traceData[0].db = Number((startLevel + 4.8).toFixed(3))
    traceData[1].db = Number((startLevel + 1.8).toFixed(3))
  }

  const addEvent = (index, delta, spike = false) => {
    if (traceData[index]) {
      traceData[index].db = Number((traceData[index].db + delta).toFixed(3))
      if (spike && traceData[index + 1]) {
        traceData[index + 1].db = Number((traceData[index + 1].db - Math.abs(delta) * 0.75).toFixed(3))
      }
    }
  }

  // Non-reflective fusion splice
  addEvent(1200, -0.15)
  addEvent(1201, -0.07)

  // Reflective connector splice
  addEvent(2500, 1.9, true)

  // End-of-fiber drop and noisy floor
  for (let index = 3800; index < points; index += 1) {
    const distance = traceData[index].distance
    const drop = Math.pow((distance - 38) / 2, 2)
    const noise = (Math.random() - 0.5) * 0.5
    traceData[index].db = Number((traceData[index].db - drop + noise).toFixed(3))
    if (traceData[index].db < 2) {
      traceData[index].db = Number((2 + Math.random() * 0.8).toFixed(3))
    }
  }

  return {
    id: `${fileName}-${Date.now()}`,
    name: fileName,
    metadata: {
      wavelength: `${wavelength} nm`,
      pulseWidth: `${pulseWidth} ns`,
      pulseDuration,
      rangeKm: `${rangeKm} km`,
      fiberCoefficient: `${fiberCoefficient} dB/km`,
      spanCount: traceData.length,
    },
    traceData,
  }
}
