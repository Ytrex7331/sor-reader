/**
 * LSA (Least Squares Approximation) Loss Calculation
 * 
 * Calculate the splice/connector loss using linear regression of the trace data
 * immediately before and after an event point.
 */
export function calculateLSALoss(tracePoints, eventDistanceKm, windowSize = 0.5) {
  if (!tracePoints || tracePoints.length < 2) return 0
  
  // Find points within the window before and after the event
  const beforePoints = tracePoints.filter(p => p.distance >= eventDistanceKm - windowSize && p.distance < eventDistanceKm)
  const afterPoints = tracePoints.filter(p => p.distance >= eventDistanceKm && p.distance <= eventDistanceKm + windowSize)
  
  if (beforePoints.length < 2 || afterPoints.length < 2) {
    // Fallback: use nearest points if window is too small
    const eventIdx = tracePoints.findIndex(p => Math.abs(p.distance - eventDistanceKm) < 0.01)
    if (eventIdx === -1) return 0
    
    const before = eventIdx > 0 ? tracePoints[eventIdx - 1] : null
    const after = eventIdx < tracePoints.length - 1 ? tracePoints[eventIdx + 1] : null
    
    if (!before || !after) return 0
    return Math.max(0, before.db - after.db)
  }
  
  // Calculate linear regression for before and after windows
  const slopeBeforeLine = linearRegression(beforePoints)
  const slopeAfterLine = linearRegression(afterPoints)
  
  // Calculate the predicted loss: difference in regression lines at the event point
  const yBeforeAtEvent = slopeBeforeLine.slope * eventDistanceKm + slopeBeforeLine.intercept
  const yAfterAtEvent = slopeAfterLine.slope * eventDistanceKm + slopeAfterLine.intercept
  
  const loss = Math.max(0, yBeforeAtEvent - yAfterAtEvent)
  
  return loss
}

/**
 * Linear Regression Helper
 * Fit a line to a set of points and return slope and intercept
 */
function linearRegression(points) {
  if (!points || points.length === 0) return { slope: 0, intercept: 0 }
  
  const n = points.length
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  
  points.forEach(p => {
    sumX += p.distance
    sumY += p.db
    sumXY += p.distance * p.db
    sumX2 += p.distance * p.distance
  })
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n
  
  return { slope, intercept }
}

/**
 * Auto-Classify Event Type
 * 
 * Connector: Has reflectance AND loss > 0
 * Splice: Has loss but negligible reflectance
 * Splitter: High structural loss (> 3.0 dB)
 */
export function classifyEventType(spliceLossValue, reflectanceValue, reflectanceThreshold = -99) {
  const hasReflectance = reflectanceValue > reflectanceThreshold
  const hasLoss = spliceLossValue > 0
  
  // Check for splitter (very high structural loss)
  if (spliceLossValue > 3.0) {
    return 'splitter'
  }
  
  // Connector: has both reflectance and loss
  if (hasReflectance && hasLoss) {
    return 'connector'
  }
  
  // Splice: has loss but no reflectance
  if (hasLoss && !hasReflectance) {
    return 'splice'
  }
  
  // Default to splice if loss is present
  if (hasLoss) {
    return 'splice'
  }
  
  // Default to splice for unknown
  return 'splice'
}

/**
 * Get Dynamic Threshold for Event Type
 * 
 * Connectors: Strict 0.5 dB max
 * Splices: Use configurable threshold (default 0.75 dB)
 * Splitters: Use configurable threshold (default 3.0 dB)
 */
export function getDynamicThreshold(eventType, configuredLossThreshold = 0.75, connectorThreshold = 0.5) {
  switch (eventType) {
    case 'connector':
      return connectorThreshold // Strict 0.5 dB for connectors
    case 'splitter':
      return 3.0 // Splitters have high thresholds
    case 'splice':
    default:
      return configuredLossThreshold
  }
}

/**
 * Check if Event Fails Dynamic Threshold
 */
export function eventFailsDynamicThreshold(event, eventType) {
  const threshold = getDynamicThreshold(eventType)
  const spliceLoss = Number(event.spliceLoss) || 0
  return spliceLoss > threshold
}

/**
 * Create New Event from Cursor Position
 * 
 * Used when user adds event via right-click on cursor
 */
export function createEventFromCursor(cursorDistance, tracePoints, reflectanceThreshold = -99, baseEventNumber = 1) {
  const lsaLoss = calculateLSALoss(tracePoints, cursorDistance)
  const reflectance = 0 // Default to no reflectance for newly created events
  const eventType = classifyEventType(lsaLoss, reflectance, reflectanceThreshold)
  
  return {
    eventNumber: `NEW-${baseEventNumber}`,
    distanceKm: cursorDistance,
    spliceLossValue: lsaLoss,
    spliceLoss: lsaLoss.toFixed(3),
    reflectanceValue: reflectance,
    reflectance: reflectance.toFixed(3),
    eventCode: eventType === 'connector' ? '1A9999-CONN' : '1A9999',
    lossTech: 'User-added',
    eventType,
    comment: `Added via ${eventType}`,
    isLastEvent: false,
    isUserAdded: true,
    isFlagged: eventFailsDynamicThreshold({ spliceLoss: lsaLoss.toFixed(3) }, eventType)
  }
}

/**
 * Update Event Classification
 * 
 * Allow manual override and recalculate flags
 */
export function updateEventClassification(event, newEventType) {
  const threshold = getDynamicThreshold(newEventType)
  const spliceLoss = Number(event.spliceLoss) || 0
  const isFlagged = spliceLoss > threshold
  
  return {
    ...event,
    eventType: newEventType,
    eventCode: newEventType === 'connector' ? '1A9999-CONN' : '1A9999',
    isFlagged
  }
}
