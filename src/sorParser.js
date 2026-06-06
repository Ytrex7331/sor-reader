const textDecoder = new TextDecoder('ascii')
const textEncoder = new TextEncoder()
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

function readInt32(buffer, offset) {
  return new DataView(buffer).getInt32(offset, true)
}

function readNullTerminatedString(bytes, offset, maxLength = 256) {
  const end = Math.min(bytes.length, offset + maxLength)
  let stop = offset
  while (stop < end && bytes[stop] !== 0) stop += 1
  return textDecoder.decode(bytes.subarray(offset, stop))
}

function readFixedAscii(bytes, offset, length) {
  return textDecoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/, '')
}

function findAsciiOffset(buffer, tag, start = 0) {
  const bytes = new Uint8Array(buffer)
  const needle = textEncoder.encode(tag)
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

function inferWavelengthFromText(text) {
  if (!text) return undefined
  const match = text.match(/(?:\b|_)(1310|1550|850|1300|1625|1490)(?:\b|_)/i)
  if (match) {
    return `${match[1]} nm`
  }
  const fallback = text.match(/(\d{4})/)
  if (fallback) {
    return `${fallback[1]} nm`
  }
  return undefined
}

function parseMapBlock(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  const header = readNullTerminatedString(bytes, 0, 16)

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
      const name = readNullTerminatedString(bytes, offset, 128)
      offset += name.length + 1
      const version = readUint16(arrayBuffer, offset) / 100
      offset += 2
      const size = readUint32(arrayBuffer, offset)
      offset += 4
      blocks[name] = { name, version, size, pos: startpos }
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
  if (format === 2) {
    return offset + blockName.length + 1
  }
  return offset
}

function parseGenParams(arrayBuffer, blockMap, fileName) {
  const block = blockMap.blocks.GenParams
  if (!block) {
    return { language: 'EN', wavelength: inferWavelengthFromText(fileName) || 'unknown' }
  }

  const bytes = new Uint8Array(arrayBuffer)
  const offset = splitBlockHeaderOffset(block.pos, block.name, blockMap.format)
  const language = readNullTerminatedString(bytes, offset, 8) || 'EN'

  return {
    language,
    wavelength: inferWavelengthFromText(fileName) || 'unknown',
  }
}

function parseSupParams(arrayBuffer, blockMap) {
  const block = blockMap.blocks.SupParams
  if (!block) return {}

  const bytes = new Uint8Array(arrayBuffer)
  let offset = splitBlockHeaderOffset(block.pos, block.name, blockMap.format)
  const values = []
  for (let i = 0; i < 7; i += 1) {
    const value = readNullTerminatedString(bytes, offset, 128)
    values.push(value)
    offset += value.length + 1
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

  let offset = splitBlockHeaderOffset(block.pos, block.name, blockMap.format)
  offset += 4 // date/time
  const unit = readFixedAscii(new Uint8Array(arrayBuffer), offset, 2)
  offset += 2
  const wavelength = readUint16(arrayBuffer, offset) * 0.1
  offset += 2

  if (blockMap.format !== 2) {
    throw new Error('Unsupported FxdParams format')
  }

  offset += 4 // acquisition offset
  offset += 4 // acquisition offset distance
  const pulseEntries = readUint16(arrayBuffer, offset)
  offset += 2
  if (pulseEntries > 1) {
    throw new Error('Multiple pulse width entries unsupported')
  }

  const pulseWidth = readUint16(arrayBuffer, offset)
  offset += 2
  const sampleSpacingRaw = readUint32(arrayBuffer, offset)
  offset += 4
  const numDataPoints = readUint32(arrayBuffer, offset)
  offset += 4
  const indexRaw = readUint32(arrayBuffer, offset)
  offset += 4
  const backscatterRaw = readInt16(arrayBuffer, offset)
  offset += 2

  const sampleSpacingUsec = sampleSpacingRaw * 1e-8
  const indexOfRefraction = indexRaw * 1e-5
  const backscatterCoefficient = backscatterRaw * -0.1
  const dxKm = (sampleSpacingUsec * sol) / indexOfRefraction
  const fullRangeKm = dxKm * numDataPoints

  return {
    unit,
    wavelength,
    pulseWidth,
    sampleSpacingUsec,
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

  let offset = splitBlockHeaderOffset(block.pos, block.name, blockMap.format)
  const numPoints = readUint32(arrayBuffer, offset)
  offset += 4
  const numTraces = readInt16(arrayBuffer, offset)
  offset += 2
  const numPointsAgain = readUint32(arrayBuffer, offset)
  offset += 4
  const scalingRaw = readUint16(arrayBuffer, offset)
  offset += 2

  if (numPointsAgain !== numPoints) {
    console.warn('DataPts count mismatch:', numPoints, numPointsAgain)
  }
  if (numTraces !== 1) {
    console.warn('DataPts contains multiple traces; only the first will be used')
  }

  const xscaling = supParams?.otdr === 'OFL250' ? 0.1 : 1
  const fsx = (scalingRaw / 1000) * 0.001
  const sampleOffset = offset
  const availableWords = Math.floor((arrayBuffer.byteLength - sampleOffset) / 2)
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
  const genParams = parseGenParams(arrayBuffer, blockMap, fileName)
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
      cableId: supParams.supplier || 'unknown',
      fiberId: supParams.serial || 'unknown',
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
