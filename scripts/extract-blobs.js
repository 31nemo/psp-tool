#!/usr/bin/env node
// One-time script: extract base64 blobs from assets.js into .bin files
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT, 'eboot', 'assets.js'), 'utf8');
const outDir = path.join(ROOT, 'eboot', 'blobs');
fs.mkdirSync(outDir, { recursive: true });

// Match: const <name>B64 = '<base64>';
const re = /const (\w+)B64 = '([A-Za-z0-9+/=]+)';/g;
const nameMap = {
  data1: 'data1.bin',
  data2: 'data2.bin',
  datapspbody: 'datapsp.bin',
  startdatheader: 'startdat-header.bin',
  startdatfooter: 'startdat-footer.bin',
};

let match;
while ((match = re.exec(src)) !== null) {
  const [, varName, b64] = match;
  const fileName = nameMap[varName];
  if (!fileName) { console.error(`Unknown blob: ${varName}`); continue; }
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(path.join(outDir, fileName), buf);
  console.log(`${fileName}: ${buf.length} bytes`);
}
