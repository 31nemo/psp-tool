// CSO/ZSO header and conversion logic
//
// CSO/ZSO header (24 bytes):
//   0x00  4  Magic ("CISO" or "ZISO")
//   0x04  4  Header size (always 0x18 = 24)
//   0x08  8  Uncompressed ISO size (uint64 LE)
//   0x10  4  Block size (typically 2048)
//   0x14  1  Version (1)
//   0x15  1  Index shift (left-shift applied to index offsets)
//
// Followed by (totalBlocks + 1) x uint32 LE index entries.
// Each entry: bits 0-30 = offset >> indexShift, bit 31 = uncompressed flag.

import { compressBlock, decompressBlock } from './lz4.js';

export const HEADER_SIZE = 24;

export function parseHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    magic: String.fromCharCode(buf[0], buf[1], buf[2], buf[3]),
    headerSize: dv.getUint32(4, true),
    uncompressedSize: Number(dv.getBigUint64(8, true)),
    blockSize: dv.getUint32(16, true),
    version: buf[20],
    indexShift: buf[21],
  };
}

export function writeHeader(magic, uncompressedSize, blockSize, indexShift) {
  const buf = new Uint8Array(HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 4; i++) buf[i] = magic.charCodeAt(i);
  dv.setUint32(4, 0x18, true);
  dv.setBigUint64(8, BigInt(uncompressedSize), true);
  dv.setUint32(16, blockSize, true);
  buf[20] = 1;
  buf[21] = indexShift;
  return buf;
}

export function readIndex(buf, count) {
  const arr = new Uint32Array(count);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < count; i++) {
    arr[i] = dv.getUint32(HEADER_SIZE + i * 4, true);
  }
  return arr;
}

async function readSlice(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Decompress a CSO or ZSO file to raw ISO. */
export async function decompressToISO(file, onProgress) {
  const headerBuf = await readSlice(file, 0, HEADER_SIZE);
  const header = parseHeader(headerBuf);
  const format = header.magic === 'ZISO' ? 'ZSO' : 'CSO';
  const totalBlocks = Math.ceil(header.uncompressedSize / header.blockSize);
  const indexCount = totalBlocks + 1;
  const indexBuf = await readSlice(file, 0, HEADER_SIZE + indexCount * 4);
  const index = readIndex(indexBuf, indexCount);

  const result = new Uint8Array(header.uncompressedSize);
  let written = 0;

  for (let i = 0; i < totalBlocks; i++) {
    const raw0 = index[i];
    const raw1 = index[i + 1];
    const isUncompressed = (raw0 & 0x80000000) !== 0;
    const offset = (raw0 & 0x7FFFFFFF) << header.indexShift;
    const nextOffset = (raw1 & 0x7FFFFFFF) << header.indexShift;
    const blockData = await readSlice(file, offset, offset + (nextOffset - offset));

    let decompressed;
    if (isUncompressed) {
      decompressed = blockData;
    } else if (format === 'CSO') {
      decompressed = inflateRaw(blockData);
    } else {
      const remaining = header.uncompressedSize - written;
      decompressed = decompressBlock(blockData, Math.min(header.blockSize, remaining));
    }
    result.set(decompressed, written);
    written += decompressed.length;

    if (onProgress && i % 256 === 0) onProgress(i / totalBlocks, 'Decompressing block ' + i + '/' + totalBlocks);
  }

  return result;
}

/** Compress a raw ISO file to CSO or ZSO. */
export async function compressFromISO(file, targetFormat, onProgress) {
  const isoSize = file.size;
  const blockSize = 2048;
  const indexShift = 0;
  const totalBlocks = Math.ceil(isoSize / blockSize);
  const indexCount = totalBlocks + 1;
  const magic = targetFormat === 'CSO' ? 'CISO' : 'ZISO';

  const headerBytes = writeHeader(magic, isoSize, blockSize, indexShift);
  const indexBytes = new Uint8Array(indexCount * 4);
  const indexDV = new DataView(indexBytes.buffer);
  const compressedParts = [];
  let currentOffset = HEADER_SIZE + indexCount * 4;

  for (let i = 0; i < totalBlocks; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, isoSize);
    const raw = await readSlice(file, start, end);

    let compressed;
    if (targetFormat === 'CSO') {
      compressed = deflateRaw(raw);
    } else {
      compressed = compressBlock(raw);
    }

    let isUncompressed = false;
    if (compressed.length >= raw.length) {
      compressed = raw;
      isUncompressed = true;
    }

    let indexVal = currentOffset >>> indexShift;
    if (isUncompressed) indexVal |= 0x80000000;
    indexDV.setUint32(i * 4, indexVal, true);

    compressedParts.push(compressed);
    currentOffset += compressed.length;

    if (onProgress && i % 256 === 0) onProgress(i / totalBlocks, 'Compressing block ' + i + '/' + totalBlocks);
  }
  indexDV.setUint32(totalBlocks * 4, currentOffset >>> indexShift, true);

  if (onProgress) onProgress(1, 'Building output file...');
  const result = new Uint8Array(currentOffset);
  result.set(headerBytes, 0);
  result.set(indexBytes, HEADER_SIZE);
  let pos = HEADER_SIZE + indexBytes.length;
  for (const part of compressedParts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

/** Transcode between CSO and ZSO without a full ISO intermediate. */
export async function transcompress(file, sourceFormat, targetFormat, onProgress) {
  const headerBuf = await readSlice(file, 0, HEADER_SIZE);
  const header = parseHeader(headerBuf);
  const totalBlocks = Math.ceil(header.uncompressedSize / header.blockSize);
  const indexCount = totalBlocks + 1;
  const indexBuf = await readSlice(file, 0, HEADER_SIZE + indexCount * 4);
  const srcIndex = readIndex(indexBuf, indexCount);

  const blockSize = header.blockSize;
  const indexShift = 0;
  const magic = targetFormat === 'CSO' ? 'CISO' : 'ZISO';
  const outHeader = writeHeader(magic, header.uncompressedSize, blockSize, indexShift);
  const outIndexBytes = new Uint8Array(indexCount * 4);
  const outIndexDV = new DataView(outIndexBytes.buffer);
  const compressedParts = [];
  let currentOffset = HEADER_SIZE + indexCount * 4;
  let written = 0;

  for (let i = 0; i < totalBlocks; i++) {
    const raw0 = srcIndex[i];
    const raw1 = srcIndex[i + 1];
    const isUncompressed = (raw0 & 0x80000000) !== 0;
    const offset = (raw0 & 0x7FFFFFFF) << header.indexShift;
    const nextOffset = (raw1 & 0x7FFFFFFF) << header.indexShift;
    const blockData = await readSlice(file, offset, offset + (nextOffset - offset));

    let decompressed;
    if (isUncompressed) {
      decompressed = blockData;
    } else if (sourceFormat === 'CSO') {
      decompressed = inflateRaw(blockData);
    } else {
      const remaining = header.uncompressedSize - written;
      decompressed = decompressBlock(blockData, Math.min(blockSize, remaining));
    }
    written += decompressed.length;

    let compressed;
    if (targetFormat === 'CSO') {
      compressed = deflateRaw(decompressed);
    } else {
      compressed = compressBlock(decompressed);
    }

    let storeUncompressed = false;
    if (compressed.length >= decompressed.length) {
      compressed = decompressed;
      storeUncompressed = true;
    }

    let indexVal = currentOffset >>> indexShift;
    if (storeUncompressed) indexVal |= 0x80000000;
    outIndexDV.setUint32(i * 4, indexVal, true);

    compressedParts.push(compressed);
    currentOffset += compressed.length;

    if (onProgress && i % 256 === 0) onProgress(i / totalBlocks, 'Transcoding block ' + i + '/' + totalBlocks);
  }
  outIndexDV.setUint32(totalBlocks * 4, currentOffset >>> indexShift, true);

  if (onProgress) onProgress(1, 'Building output file...');
  const result = new Uint8Array(currentOffset);
  result.set(outHeader, 0);
  result.set(outIndexBytes, HEADER_SIZE);
  let pos = HEADER_SIZE + outIndexBytes.length;
  for (const part of compressedParts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
