const textDecoder = new TextDecoder('ascii')
const sol = 299792.458 // Speed of light in km/s

// --- UTILITY FUNCTIONS ---

function readUint16(buffer, offset) { return new DataView(buffer).getUint16(offset, true) }
function readUint32(buffer, offset) { return new DataView(buffer).getUint32(offset, true) }
function readInt16(buffer, offset) { return new DataView(buffer).getInt16(offset, true) }
function readInt32(buffer, offset) { return new DataView(buffer).getInt32(offset, true) }

function readNullTerminatedString(bytes, offset, maxLength = 256) {
  const end = Math.min(bytes.length, offset + maxLength)
  let stop = offset
  while (stop < end && bytes[stop] !== 0) stop += 1
  const str = textDecoder.decode(bytes.subarray(offset, stop))
  const bytesRead = stop < end && bytes[stop] === 0 ? stop - offset + 1 : stop - offset
  return { str, bytesRead }
}

function readFixedAscii(bytes, offset, length) {
  return textDecoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/, '')
}

function splitBlockHeaderOffset(offset, blockName, format) {
  return format === 2 ? offset + blockName.length + 1 : offset
}

// --- CRC-16 CHECKSUM UTILITIES ---
// CRC-16 CCITT-FALSE: poly 0x1021, init 0xFFFF (IBM 3740 / "CCITT False")
function crc16CcittFalse(buffer) {
  let crc = 0xFFFF
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i] << 8
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) > 0) crc = (crc << 1) ^ 0x1021
      else crc = crc << 1
    }
  }
  return crc & 0xFFFF
}

// CRC-16 Kermit (CCITT): same poly 0x1021, but init 0x0000 and bit-reversed input/output.
// Some OTDR vendors used this variant instead of CCITT-FALSE due to spec ambiguity.
function crc16Kermit(buffer) {
  let crc = 0x0000
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) crc = (crc >>> 1) ^ 0x8408
      else crc = crc >>> 1
    }
  }
  return crc & 0xFFFF
}

// Try both CRC variants against a stored u16 value.
// Returns { matched: true, variant, value } or { matched: false }.
function matchCrc(buffer, storedU16) {
  const ccitt = crc16CcittFalse(buffer)
  if (ccitt === storedU16) return { matched: true, variant: 'CRC16_CCITT_FALSE', value: ccitt }
  const kermit = crc16Kermit(buffer)
  if (kermit === storedU16) return { matched: true, variant: 'CRC16_KERMIT', value: kermit }
  return { matched: false }
}

// --- FORMAT 1 (OLD SOR) PARSER ---
// Format 1 files have no map block. The blocks follow each other sequentially,
// each starting with a null-terminated identifier. We scan forward identifying
// known block headers and build a synthetic blockMap compatible with the
// format-2 parsers so they can be reused without modification.
//
// Known limitations vs format 2:
//   - Block sizes are not stored, so we cannot skip unknown blocks safely.
//   - We stop scanning at the first unrecognised header.
//   - The checksum field (if any) is not in a named block, so checksum
//     validation is skipped for format-1 files.
function buildFormat1BlockMap(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  const KNOWN_ORDER = ['GenParams', 'SupParams', 'FxdParams', 'KeyEvents', 'LnkParams', 'DataPts']
  const blocks = {}
  let pos = 0

  for (const name of KNOWN_ORDER) {
    if (pos >= bytes.length) break
    // Check if the bytes at pos match "name\0"
    const expected = name + '\0'
    let match = true
    if (pos + expected.length > bytes.length) { match = false }
    else {
      for (let i = 0; i < expected.length; i++) {
        if (bytes[pos + i] !== expected.charCodeAt(i)) { match = false; break }
      }
    }
    if (!match) break  // Unknown block encountered — stop scanning

    // For format 1 we don't know the size, so we set size=-1 as a sentinel.
    // Parsers that care about size (bounds-checking) will see -1 and handle accordingly.
    blocks[name] = { name, version: 1.0, size: -1, pos }
    // Advance past the header so the next iteration can probe the next block.
    // The block parsers themselves advance their own offset, so we don't need
    // to skip the full block body here — we rely on parsers consuming exactly
    // what they need. This is only usable because we call each parser exactly once.
    pos += expected.length
    // Skip ahead by reading what we know the block consumes.
    // We can't do this without actually parsing, so just record the pos for the
    // header location and let the individual parsers use splitBlockHeaderOffset(format=1)
    // which returns offset=0 (no header skip needed for format 1).
  }

  return {
    format: 1,
    version: 1.0,
    mapblock: null,
    blocks
  }
}



function parseMapBlock(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  const header = readNullTerminatedString(bytes, 0, 16).str

  if (header === 'Map') {
    let offset = 4
    const versionRaw = readUint16(arrayBuffer, offset)
    offset += 2
    const mapBytes = readUint32(arrayBuffer, offset)
    offset += 4
    const nblocks = readUint16(arrayBuffer, offset) - 1
    offset += 2

    const blocks = {}
    let startpos = mapBytes
    for (let i = 0; i < nblocks; i += 1) {
      const chunk = readNullTerminatedString(bytes, offset, 128)
      const name = chunk.str
      offset += chunk.bytesRead
      const version = readUint16(arrayBuffer, offset) / 100
      offset += 2
      const size = readInt32(arrayBuffer, offset) // Note: size is signed i32 in spec
      offset += 4
      if (name) blocks[name] = { name, version, size, pos: startpos }
      startpos += Math.max(0, size)
    }

    return { format: 2, version: Number((versionRaw * 0.01).toFixed(2)), mapblock: { nbytes: mapBytes, nblocks }, blocks }
  }

  return { format: 1, version: 1.0, mapblock: null, blocks: {} }
}

function parseGenParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.GenParams
  if (!block) return {}

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const view = new DataView(arrayBuffer, block.pos, block.size)

  const languageCode = readFixedAscii(bytes, offset, 2).trim(); offset += 2
  let chunk = readNullTerminatedString(bytes, offset); const cableId = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const fiberId = chunk.str.trim(); offset += chunk.bytesRead
  const fiberType = view.getInt16(offset, true); offset += 2
  const nominalWavelength = view.getInt16(offset, true); offset += 2
  chunk = readNullTerminatedString(bytes, offset); const originatingLocation = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const terminatingLocation = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const cableCode = chunk.str.trim(); offset += chunk.bytesRead
  const currentDataFlag = readFixedAscii(bytes, offset, 2).trim(); offset += 2
  const userOffset = view.getInt32(offset, true); offset += 4
  const userOffsetDistance = view.getInt32(offset, true); offset += 4
  chunk = readNullTerminatedString(bytes, offset); const operator = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const comment = chunk.str.trim(); offset += chunk.bytesRead

  return { languageCode, cableId, fiberId, fiberType, nominalWavelength, originatingLocation, terminatingLocation, cableCode, currentDataFlag, userOffset, userOffsetDistance, operator, comment }
}

function parseSupParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.SupParams
  if (!block) return {}

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)

  let chunk = readNullTerminatedString(bytes, offset); const supplier = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const otdr = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const serial = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const module = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const moduleSerial = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const software = chunk.str.trim(); offset += chunk.bytesRead
  chunk = readNullTerminatedString(bytes, offset); const other = chunk.str.trim(); offset += chunk.bytesRead

  return { supplier, otdr, serial, module, moduleSerial, software, other }
}

function parseFxdParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.FxdParams
  if (!block) return null

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const view = new DataView(arrayBuffer, block.pos, block.size)

  const dateTimeStamp = view.getUint32(offset, true); offset += 4
  const unitsOfDistance = readFixedAscii(bytes, offset, 2).trim(); offset += 2
  const wavelength = view.getInt16(offset, true) * 0.1; offset += 2
  const acquisitionOffset = view.getInt32(offset, true); offset += 4
  const acquisitionOffsetDistance = view.getInt32(offset, true); offset += 4
  const totalNPulseWidthsUsed = view.getInt16(offset, true); offset += 2

  const pulseWidths = [], dataSpacings = [], nDataPoints = []
  for (let i = 0; i < totalNPulseWidthsUsed; i++) { pulseWidths.push(view.getInt16(offset, true)); offset += 2 }
  for (let i = 0; i < totalNPulseWidthsUsed; i++) { dataSpacings.push(view.getInt32(offset, true)); offset += 4 }
  for (let i = 0; i < totalNPulseWidthsUsed; i++) { nDataPoints.push(view.getInt32(offset, true)); offset += 4 }

  const groupIndex = view.getInt32(offset, true) * 1e-5; offset += 4
  const backscatterCoefficient = view.getInt16(offset, true) * -0.1; offset += 2
  const numberOfAverages = view.getInt32(offset, true); offset += 4
  const averagingTime = view.getUint16(offset, true) * 0.1; offset += 2
  const acquisitionRange = view.getInt32(offset, true); offset += 4
  const acquisitionRangeDistance = view.getInt32(offset, true); offset += 4
  const frontPanelOffset = view.getInt32(offset, true); offset += 4
  const noiseFloorLevel = view.getUint16(offset, true); offset += 2
  const noiseFloorScaleFactor = view.getInt16(offset, true); offset += 2
  const powerOffsetFirstPoint = view.getUint16(offset, true); offset += 2

  // Combined noise floor in dB: level × scaleFactor × 0.001
  // e.g. noiseFloorLevel=30342, noiseFloorScaleFactor=1000 → -30.342 dB
  const noiseFloorDb = Number((noiseFloorLevel * noiseFloorScaleFactor * 0.001 * -0.001).toFixed(4))

  const lossThreshold = view.getUint16(offset, true) * 0.001; offset += 2
  const reflectanceThreshold = view.getUint16(offset, true) * -0.001; offset += 2
  const endOfFibreThreshold = view.getUint16(offset, true) * 0.001; offset += 2
  const traceType = readFixedAscii(bytes, offset, 2).trim(); offset += 2

  const windowCoords = [
    view.getInt32(offset, true), view.getInt32(offset + 4, true),
    view.getInt32(offset + 8, true), view.getInt32(offset + 12, true)
  ]; offset += 16

  // Per-segment dx and range — one entry per pulse width.
  // Segment 0 is used as the primary/display value for backward compatibility.
  const segmentDx = dataSpacings.map((spacing, idx) => {
    const sampleSpacingUsec = spacing * 1e-6
    const dx = groupIndex > 0 ? (sampleSpacingUsec * (sol / 1e6)) / groupIndex : 0
    return { dxKm: Number(dx.toFixed(9)), fullRangeKm: Number((dx * (nDataPoints[idx] || 0)).toFixed(6)) }
  })

  const dxKm = segmentDx[0]?.dxKm ?? 0
  const fullRangeKm = segmentDx[0]?.fullRangeKm ?? 0

  // userOffset physical conversion:
  //   userOffset is in 100ps units → seconds = raw × 100e-12
  //   one-way distance = (time × sol_km_per_s) / groupIndex
  //   userOffsetDistance is in 10× the file's distance unit (km or mt) → divide by 10
  const userOffsetSeconds = acquisitionOffset * 100e-12
  const userOffsetKm = groupIndex > 0 ? (userOffsetSeconds * sol) / groupIndex : 0
  const userOffsetDistanceScaled = acquisitionOffsetDistance / 10  // in file distance units

  return {
    dateTime: new Date(dateTimeStamp * 1000).toISOString(), dateTimeStamp, unitsOfDistance, wavelength,
    acquisitionOffset, acquisitionOffsetDistance, totalNPulseWidthsUsed, pulseWidths, dataSpacings, nDataPoints,
    indexOfRefraction: groupIndex, backscatterCoefficient, numberOfAverages, averagingTime, acquisitionRange,
    acquisitionRangeDistance, frontPanelOffset,
    noiseFloorLevel, noiseFloorScaleFactor, noiseFloorDb,
    powerOffsetFirstPoint,
    lossThreshold, reflectanceThreshold, endOfFibreThreshold, traceType, windowCoords,
    // Per-segment distance metadata — use segmentDx[n] when iterating multi-pulse-width files
    segmentDx,
    // Segment-0 values kept at top level for backward compatibility
    dxKm, fullRangeKm,
    // userOffset in physical units (acquisitionOffset → km, acquisitionOffsetDistance → file distance unit)
    userOffsetKm: Number(userOffsetKm.toFixed(6)),
    userOffsetDistanceScaled: Number(userOffsetDistanceScaled.toFixed(4))
  }
}

function parseKeyEvents(arrayBuffer, blockMap, fxdParams) {
  const block = blockMap.blocks.KeyEvents
  if (!block) return null

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const view = new DataView(arrayBuffer, block.pos, block.size)

  if (offset >= bytes.length) return null
  const numberOfKeyEvents = view.getInt16(offset, true); offset += 2
  const events = []
  let lastEventSummary = null;

  for (let i = 0; i < numberOfKeyEvents; i++) {
    if (offset + 42 > bytes.length) break
    const isLastEvent = (i === numberOfKeyEvents - 1);
    
    const eventNumber = view.getInt16(offset, true)
    const propagationTime = view.getInt32(offset + 2, true) 
    const slope = view.getInt16(offset + 6, true) * 0.001 
    const spliceLoss = view.getInt16(offset + 8, true) * 0.001 
    const reflectance = view.getInt32(offset + 10, true) * 0.001 
    const eventCode = readFixedAscii(bytes, offset + 14, 6).trim()
    const lossTech = readFixedAscii(bytes, offset + 20, 2).trim()
    const markers = [
      view.getInt32(offset + 22, true), view.getInt32(offset + 26, true),
      view.getInt32(offset + 30, true), view.getInt32(offset + 34, true), view.getInt32(offset + 38, true)
    ]
    offset += 42 

    const chunk = readNullTerminatedString(bytes, offset)
    const comment = chunk.str.trim()
    offset += chunk.bytesRead

    // Handle LastKeyEvent unique structure
    if (isLastEvent && offset + 22 <= bytes.length) {
      lastEventSummary = {
        endToEndLoss: view.getInt32(offset, true) * 0.001,
        endToEndMarker1: view.getInt32(offset + 4, true),
        endToEndMarker2: view.getInt32(offset + 8, true),
        opticalReturnLoss: view.getUint16(offset + 12, true) * 0.001,
        orlMarker1: view.getInt32(offset + 14, true),
        orlMarker2: view.getInt32(offset + 18, true),
      };
      offset += 22;
    }

    let distanceKm = 0
    if (fxdParams && fxdParams.indexOfRefraction) {
      distanceKm = (propagationTime * 1e-11 * sol) / (2 * fxdParams.indexOfRefraction)
    }

    events.push({
      eventNumber, propagationTime, distanceKm: Number(distanceKm.toFixed(6)), slope, spliceLoss,
      reflectance: reflectance <= -999 ? null : reflectance, eventCode, lossTech, markers, comment,
      isLastEvent, endToEndSummary: isLastEvent ? lastEventSummary : null
    })
  }

  return { numberOfKeyEvents, events }
}

function parseLnkParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.LnkParams
  if (!block) return null

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const view = new DataView(arrayBuffer, block.pos, block.size)

  if (offset >= bytes.length) return null
  const numberOfLandmarks = view.getInt16(offset, true); offset += 2
  const landmarks = []

  for (let i = 0; i < numberOfLandmarks; i++) {
    const landmarkNumber = view.getInt16(offset, true); offset += 2
    const landmarkCode = readFixedAscii(bytes, offset, 2).trim(); offset += 2
    const landmarkLocation = view.getInt32(offset, true); offset += 4
    const relatedEventNumber = view.getInt16(offset, true); offset += 2
    const gpsLongitude = view.getInt32(offset, true); offset += 4
    const gpsLatitude = view.getInt32(offset, true); offset += 4
    const fiberCorrectionFactor = view.getInt16(offset, true); offset += 2
    const sheathEntering = view.getInt32(offset, true); offset += 4
    const sheathLeaving = view.getInt32(offset, true); offset += 4
    const units = readFixedAscii(bytes, offset, 2).trim(); offset += 2
    const mfd = view.getInt16(offset, true); offset += 2
    
    const chunk = readNullTerminatedString(bytes, offset)
    const comment = chunk.str.trim()
    offset += chunk.bytesRead

    landmarks.push({
      landmarkNumber, landmarkCode, landmarkLocation, relatedEventNumber, gpsLongitude, gpsLatitude,
      fiberCorrectionFactor, sheathEntering, sheathLeaving, units, mfd, comment
    })
  }

  return { numberOfLandmarks, landmarks }
}

function parseDataPts(arrayBuffer, blockMap, fxdParams) {
  const block = blockMap.blocks.DataPts
  if (!block) throw new Error('DataPts block missing')

  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const view = new DataView(arrayBuffer, block.pos, block.size)

  const numberOfDataPoints = view.getInt32(offset, true); offset += 4
  const totalNumberScaleFactorsUsed = view.getInt16(offset, true); offset += 2
  const scaleFactors = []

  for (let sf = 0; sf < totalNumberScaleFactorsUsed; sf++) {
    const nPoints = view.getInt32(offset, true); offset += 4
    const scaleFactorRaw = view.getInt16(offset, true); offset += 2
    // Scale factor: stored as dB*1000*1000 (i.e. dB/point = raw / 1e6)
    const fsx = (scaleFactorRaw / 1000) * 0.001

    // Use the per-segment dxKm if available; fall back to segment-0 for single-pulse files.
    const dxKm = fxdParams?.segmentDx?.[sf]?.dxKm ?? fxdParams?.dxKm ?? 0

    // Collect raw u16 values first (preserves absolute power information).
    // The raw values are backscatter power encoded as unsigned 16-bit integers;
    // they are NOT relative to each other across segments.
    const rawData = new Uint16Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      rawData[i] = view.getUint16(offset + i * 2, true)
    }
    offset += nPoints * 2

    // Derive relative-loss trace from the raw values.
    // The OTDR stores power descending: highest raw = lowest loss (near end).
    // Loss in dB = (maxRaw - rawVal) * fsx
    const maxRaw = nPoints > 0 ? Math.max(...rawData) : 0
    const traceData = new Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      traceData[i] = {
        distance: Number((dxKm * i).toFixed(6)),
        db: Number(((maxRaw - rawData[i]) * fsx).toFixed(4)),
        raw: rawData[i]   // ← retained: allows absolute power reconstruction
      }
    }

    scaleFactors.push({ nPoints, scaleFactorRaw, dxKm, traceData })
  }

  return { totalPoints: numberOfDataPoints, segments: scaleFactors }
}

function parseChecksumBlock(arrayBuffer, blockMap) {
  const block = blockMap.blocks.Cksum
  if (!block) return null
  const view = new DataView(arrayBuffer, block.pos, block.size)
  const offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  // Spec stores this as a 16-bit value. Read as u16 (unsigned) to avoid sign-mangling
  // values in the 0x8000–0xFFFF range when compared against CRC output.
  return { checksum: view.getUint16(offset, true) }
}

function validateChecksum(arrayBuffer, blockMap, parsedCksum) {
  if (!parsedCksum) return { status: 'Missing' }

  const bytes = new Uint8Array(arrayBuffer)
  const mapBlockData = blockMap.mapblock
  if (!mapBlockData || !blockMap.blocks.Cksum) return { status: 'Error' }

  // parseChecksumBlock now always returns a u16, so no masking needed.
  const stored = parsedCksum.checksum
  const ckBlockPos = blockMap.blocks.Cksum.pos
  const headerLen = 'Cksum'.length + 1

  // Strategy 1: CRC over all bytes strictly before the Checksum block.
  const m1 = matchCrc(bytes.slice(0, ckBlockPos), stored)
  if (m1.matched) {
    return { status: 'Valid', strategy: 'PrecedingBytes', stored, crcVariant: m1.variant }
  }

  // Strategy 2: CRC over whole file with the 2-byte checksum field zeroed.
  const checksumFieldOff = ckBlockPos + headerLen
  if (checksumFieldOff + 2 <= bytes.length) {
    const zeroedBytes = new Uint8Array(bytes.length)
    zeroedBytes.set(bytes)
    zeroedBytes[checksumFieldOff] = 0
    zeroedBytes[checksumFieldOff + 1] = 0
    const m2 = matchCrc(zeroedBytes, stored)
    if (m2.matched) {
      return { status: 'Valid', strategy: 'WholeFileChecksumZeroed', stored, crcVariant: m2.variant }
    }
  }

  // Strategy 3: CRC over whole file excluding the entire Checksum block.
  const afterBlock = ckBlockPos + blockMap.blocks.Cksum.size
  if (afterBlock <= bytes.length) {
    const excludingBytes = new Uint8Array(bytes.length - blockMap.blocks.Cksum.size)
    excludingBytes.set(bytes.slice(0, ckBlockPos), 0)
    excludingBytes.set(bytes.slice(afterBlock), ckBlockPos)
    const m3 = matchCrc(excludingBytes, stored)
    if (m3.matched) {
      return { status: 'Valid', strategy: 'WholeFileExcludingBlock', stored, crcVariant: m3.variant }
    }
  }

  return { status: 'Mismatch', stored }
}

function parseProprietaryBlocks(arrayBuffer, blockMap) {
  const knownTags = ['GenParams', 'SupParams', 'FxdParams', 'DataPts', 'KeyEvents', 'LnkParams', 'Cksum']
  const proprietary = []

  Object.keys(blockMap.blocks).forEach(key => {
    if (knownTags.includes(key)) return
    const block = blockMap.blocks[key]
    if (block.size <= 0) return

    const rawData = new Uint8Array(arrayBuffer, block.pos, block.size)

    // Skip the block header (null-terminated identifier string) so we expose only the payload.
    const headerLen = key.length + 1
    const payload = rawData.slice(headerLen)

    // Extract all null-terminated ASCII strings found in the payload.
    // This surfaces human-readable fields in vendor blocks (calibration dates, model IDs, etc.)
    const strings = []
    let i = 0
    while (i < payload.length) {
      let end = i
      while (end < payload.length && payload[end] !== 0) end++
      if (end > i) {
        const candidate = textDecoder.decode(payload.subarray(i, end))
        // Only keep strings that are mostly printable ASCII (>= 4 chars, < 128 code points)
        if (candidate.length >= 4 && [...candidate].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 128)) {
          strings.push(candidate)
        }
      }
      i = end + 1
    }

    // Produce a compact hex dump of the full raw block (header included) for binary analysis.
    const hexDump = Array.from(rawData)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ')

    proprietary.push({
      header: key,
      size: block.size,
      // Raw bytes of the full block (header + payload) — enables full binary reconstruction
      rawBytes: Array.from(rawData),
      // Printable strings extracted from the payload
      strings,
      // Hex dump for manual inspection / debugging
      hexDump
    })
  })

  return proprietary
}

// --- MAIN EXPORT ---

export function parseSorArrayBuffer(arrayBuffer, fileName) {
  let blockMap = parseMapBlock(arrayBuffer)

  // If no 'Map' header was found the file may be an older format-1 SOR.
  // Attempt a sequential scan to locate known blocks.
  if (blockMap.format === 1) {
    blockMap = buildFormat1BlockMap(arrayBuffer)
  }
  
  const genParams = parseGenParams(arrayBuffer, blockMap)
  const supParams = parseSupParams(arrayBuffer, blockMap)
  const fxdParams = parseFxdParams(arrayBuffer, blockMap)
  const dataPts = parseDataPts(arrayBuffer, blockMap, fxdParams)
  const keyEvents = parseKeyEvents(arrayBuffer, blockMap, fxdParams)
  const lnkParams = parseLnkParams(arrayBuffer, blockMap)
  const proprietaryBlocks = parseProprietaryBlocks(arrayBuffer, blockMap)
  
  const checksumBlock = parseChecksumBlock(arrayBuffer, blockMap)
  const checksumValidation = validateChecksum(arrayBuffer, blockMap, checksumBlock)

  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? `${fileName}-${crypto.randomUUID()}`
    : `${fileName}-${Date.now()}`

  return {
    id,
    name: fileName,
    supplier: supParams,
    general: genParams,
    fixed: fxdParams,
    dataPoints: dataPts, // Updated to hold multi-segments
    keyEvents,           // Updated with EndToEnd metrics
    linkParameters: lnkParams,
    proprietaryBlocks,
    checksum: {
      block: checksumBlock,
      validation: checksumValidation
    },
    metadata: {
      wavelength: fxdParams ? `${fxdParams.wavelength.toFixed(1)} nm` : '--',
      pulseWidth: fxdParams ? `${fxdParams.pulseWidths[0] || '--'} ns` : '--',
      ior: fxdParams ? `${fxdParams.indexOfRefraction.toFixed(6)}` : '--',
      totalPoints: dataPts.totalPoints,
      location: genParams.originatingLocation || '--',
      cableId: genParams.cableId || '--',
      fiberId: genParams.fiberId || '--',
      operator: genParams.operator || '--',
      comments: genParams.comment || '--',
      backscatterCoefficient: fxdParams ? `${fxdParams.backscatterCoefficient.toFixed(1)} dB` : '--',
      isValid: checksumValidation.status === 'Valid' || checksumValidation.status === 'Missing'
    },
  }
}

export async function parseSorFile(file) {
  const arrayBuffer = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })

  return parseSorArrayBuffer(arrayBuffer, file.name)
}