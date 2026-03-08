// ZIP Web Worker — creates ZIP archives off the main thread
//
// Message protocol:
//   IN:  { entries: [{name: string, data: ArrayBuffer}] }  (data transferred in)
//   OUT: { result: ArrayBuffer }                            (result transferred out)

/** CRC-32 (ISO 3309) with lazy table initialization. */
function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Create a ZIP archive containing one or more stored (uncompressed) files. */
function createZip(entries, onProgress) {
  const enc = new TextEncoder();
  const total = entries.length;

  // Phase 1: CRC (the expensive part — loops over every byte)
  const meta = entries.map((e, i) => {
    if (onProgress) onProgress('crc', i, total);
    const nameBytes = enc.encode(e.name);
    return { nameBytes, crc: crc32(e.data), size: e.data.length, nameLen: nameBytes.length };
  });

  const localSize = meta.reduce((sum, m) => sum + 30 + m.nameLen + m.size, 0);
  const cdSize = meta.reduce((sum, m) => sum + 46 + m.nameLen, 0);
  const totalSize = localSize + cdSize + 22;

  if (onProgress) onProgress('alloc', 0, total);
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;

  const localOffsets = [];

  // Phase 2: copy data into ZIP buffer
  for (let i = 0; i < entries.length; i++) {
    if (onProgress) onProgress('copy', i, total);
    const m = meta[i];
    localOffsets.push(off);
    view.setUint32(off, 0x04034B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    bytes.set(m.nameBytes, off); off += m.nameLen;
    bytes.set(entries[i].data, off); off += m.size;
  }

  const cdOffset = off;
  for (let i = 0; i < entries.length; i++) {
    const m = meta[i];
    view.setUint32(off, 0x02014B50, true); off += 4;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 20, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, m.crc, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint32(off, m.size, true); off += 4;
    view.setUint16(off, m.nameLen, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint32(off, 0, true); off += 4;
    view.setUint32(off, localOffsets[i], true); off += 4;
    bytes.set(m.nameBytes, off); off += m.nameLen;
  }

  const cdLen = off - cdOffset;
  view.setUint32(off, 0x06054B50, true); off += 4;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, 0, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint16(off, entries.length, true); off += 2;
  view.setUint32(off, cdLen, true); off += 4;
  view.setUint32(off, cdOffset, true); off += 4;
  view.setUint16(off, 0, true); off += 2;

  return new Uint8Array(buf);
}

self.onmessage = function(e) {
  const entries = e.data.entries.map(entry => ({
    name: entry.name,
    data: new Uint8Array(entry.data),
  }));
  const result = createZip(entries, (phase, index, total) => {
    self.postMessage({ type: 'progress', phase, index, total });
  });
  self.postMessage({ type: 'done', result: result.buffer }, [result.buffer]);
};
