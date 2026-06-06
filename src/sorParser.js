const textDecoder = new TextDecoder('ascii')
const sol = 299792.458 / 1e6 // speed of light in km/usec

function readUint16(buffer, offset) {
  return new DataView(buffer).getUint16(offset, true)
}

function readUint32(buffer, offset) {
  return new DataView(buffer).getUint32(offset, true)
}

function readInt16(buffer, offset) {
  return new DataView(buffer).getInt16(offset, true)
}

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

function isPrintableAscii(text) {
  return /^[\t\n\r\x20-\x7e]*$/.test(text)
}

function findAsciiOffset(buffer, tag, start = 0) {
  const bytes = new Uint8Array(buffer)
  const needle = new TextEncoder().encode(tag)
  const end = bytes.length - needle.length
  for (let i = start; i <= end; i += 1) {
    let found = true
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        found = false
        break
      }
    }
    if (found) return i
  }
  return -1
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
      const size = readUint32(arrayBuffer, offset)
      offset += 4
      if (name) {
        blocks[name] = { name, version, size, pos: startpos }
      }
      startpos += size
    }

    return {
      format: 2,
      version: Number((versionRaw * 0.01).toFixed(2)),
      mapblock: { nbytes: mapBytes, nblocks },
      blocks,
    }
  }

  const knownTags = ['GenParams', 'SupParams', 'FxdParams', 'DataPts', 'KeyEvents', 'Cksum']
  const blocks = {}
  for (const tag of knownTags) {
    const pos = findAsciiOffset(arrayBuffer, tag)
    if (pos !== -1) {
      blocks[tag] = { name: tag, pos }
    }
  }

  return {
    format: 1,
    version: 1.0,
    mapblock: null,
    blocks,
  }
}

function splitBlockHeaderOffset(offset, blockName, format) {
  return format === 2 ? offset + blockName.length + 1 : offset
}

function readStringField(bytes, offset, maxLength = 256) {
  const entry = readNullTerminatedString(bytes, offset, maxLength)
  if (entry.bytesRead === maxLength && bytes[offset + maxLength - 1] !== 0) {
    return { str: readFixedAscii(bytes, offset, maxLength), bytesRead: maxLength }
  }
  return entry
}

function parseGenParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.GenParams
  if (!block) return {}

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)

  const fields = []
  while (offset < bytes.length && fields.length < 8) {
    const entry = readStringField(bytes, offset, 128)
    fields.push(entry.str.trim())
    if (entry.bytesRead === 0) break
    offset += entry.bytesRead
  }

  const hasPrintableStrings = fields.length >= 4 && fields.every((value) => {
    if (!value) return true
    return isPrintableAscii(value)
  })

  if (hasPrintableStrings && fields.length >= 8) {
    const [language, cableId, fiberId, location, building, room, operator, comments] = fields
    return {
      language: language || undefined,
      cableId: cableId || undefined,
      fiberId: fiberId || undefined,
      location: location || undefined,
      building: building || undefined,
      room: room || undefined,
      operator: operator || undefined,
      comments: comments || undefined,
    }
  }

  const language = readFixedAscii(bytes, 0, 2).trim()
  return { language: language || undefined }
}

function parseSupParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.SupParams
  if (!block) return {}

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const values = []

  while (offset < bytes.length && values.length < 7) {
    const entry = readStringField(bytes, offset, 128)
    values.push(entry.str.trim())
    if (entry.bytesRead === 0) break
    offset += entry.bytesRead
  }

  return {
    supplier: values[0] || 'unknown',
    otdr: values[1] || 'unknown',
    serial: values[2] || 'unknown',
    module: values[3] || 'unknown',
    moduleSerial: values[4] || 'unknown',
    software: values[5] || 'unknown',
    other: values[6] || '',
  }
}

function parseFxdParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.FxdParams
  if (!block) {
    throw new Error('FxdParams block missing')
  }

  const bytes = new Uint8Array(arrayBuffer, block.pos, block.size)
  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  offset += 4 // date/time or reserved header
  const unit = readFixedAscii(bytes, offset, 2)
  offset += 2
  const wavelength = readUint16(arrayBuffer, block.pos + offset) * 0.1
  offset += 2

  if (blockMap.format !== 2) {
    throw new Error('Unsupported FxdParams format')
  }

  offset += 4 // acquisition offset
  offset += 4 // acquisition offset distance
  const pulseEntries = readUint16(arrayBuffer, block.pos + offset)
  offset += 2
  const pulseWidth = readUint16(arrayBuffer, block.pos + offset)
  offset += 2
  const sampleSpacingRaw = readUint32(arrayBuffer, block.pos + offset)
  offset += 4
  const numDataPoints = readUint32(arrayBuffer, block.pos + offset)
  offset += 4
  const indexRaw = readUint32(arrayBuffer, block.pos + offset)
  offset += 4
  offset += 2
  const backscatterRaw = readInt16(arrayBuffer, block.pos + offset)
  offset += 2

  const sampleSpacingUsec = sampleSpacingRaw * 1e-6
  const indexOfRefraction = indexRaw * 1e-5
  const backscatterCoefficient = backscatterRaw * -0.1
  const dxKm = (sampleSpacingUsec * sol) / indexOfRefraction
  const fullRangeKm = dxKm * numDataPoints

  return {
    unit,
    wavelength,
    pulseEntries,
    pulseWidth,
    sampleSpacingRaw,
    numDataPoints,
    indexOfRefraction,
    backscatterCoefficient,
    dxKm,
    fullRangeKm,
  }
}

function parseDataPts(arrayBuffer, blockMap, fxdParams, supParams) {
  const block = blockMap.blocks.DataPts
  if (!block) {
    throw new Error('DataPts block missing')
  }

  let offset = splitBlockHeaderOffset(0, block.name, blockMap.format)
  const numPoints = readUint32(arrayBuffer, block.pos + offset)
  offset += 4
  const numTraces = readInt16(arrayBuffer, block.pos + offset)
  offset += 2
  const numPointsAgain = readUint32(arrayBuffer, block.pos + offset)
  offset += 4
  const scalingRaw = readUint16(arrayBuffer, block.pos + offset)
  offset += 2

  if (numPointsAgain !== numPoints) {
    console.warn('DataPts count mismatch:', numPoints, numPointsAgain)
  }
  if (numTraces !== 1) {
    console.warn('DataPts contains multiple traces; only the first will be used')
  }

  const xscaling = supParams?.otdr === 'OFL250' ? 0.1 : 1
  const fsx = (scalingRaw / 1000) * 0.001
  const sampleOffset = block.pos + offset
  const availableWords = Math.floor((block.pos + block.size - sampleOffset) / 2)
  const pointCount = Math.min(numPoints, availableWords)
  const sampleBytes = new Uint8Array(arrayBuffer, sampleOffset, pointCount * 2)
  const sampleView = new DataView(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength)

  const rawSamples = new Array(pointCount)
  for (let i = 0; i < pointCount; i += 1) {
    rawSamples[i] = sampleView.getUint16(i * 2, true)
  }

  const maxRaw = Math.max(...rawSamples)
  const traceData = new Array(pointCount)
  for (let i = 0; i < pointCount; i += 1) {
    const distance = Number((fxdParams.dxKm * i * xscaling).toFixed(6))
    const db = Number(((maxRaw - rawSamples[i]) * fsx).toFixed(3))
    traceData[i] = { distance, db }
  }

  return {
    traceData,
    totalPoints: pointCount,
  }
}

export function parseSorArrayBuffer(arrayBuffer, fileName) {
  const blockMap = parseMapBlock(arrayBuffer)
  const genParams = parseGenParams(arrayBuffer, blockMap)
  const supParams = parseSupParams(arrayBuffer, blockMap)
  const fxdParams = parseFxdParams(arrayBuffer, blockMap)
  const { traceData, totalPoints } = parseDataPts(arrayBuffer, blockMap, fxdParams, supParams)

  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? `${fileName}-${crypto.randomUUID()}`
    : `${fileName}-${Date.now()}`

  return {
    id,
    name: fileName,
    metadata: {
      wavelength: `${fxdParams.wavelength.toFixed(1)} nm`,
      pulseWidth: `${fxdParams.pulseWidth} ns`,
      ior: `${fxdParams.indexOfRefraction.toFixed(6)}`,
      totalPoints,
      location:   genParams.location  || '--',
      cableId:    genParams.cableId   || '--',
      fiberId:    genParams.fiberId   || '--',
      operator:   genParams.operator  || '--',
      comments:   genParams.comments  || '--',
      backscatterCoefficient: `${fxdParams.backscatterCoefficient.toFixed(1)} dB`,
    },
    traceData,
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
