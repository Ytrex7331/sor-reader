import fs from 'fs';
import { parseSorArrayBuffer } from './src/sorParser.js';

const buffer = fs.readFileSync('AXS-005_1310_10ns.sor');
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const result = parseSorArrayBuffer(arrayBuffer, 'AXS-005_1310_10ns.sor');

console.log("Total points:", result.traceData.length);
console.log("First 5 points:", result.traceData.slice(0, 5));
console.log("Last 5 points:", result.traceData.slice(-5));
