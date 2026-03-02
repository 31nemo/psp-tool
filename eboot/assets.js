// Binary assets needed for EBOOT.PBP construction
//
// Provides the DATA.PSP blob for the PBP container. In a production build,
// blobs are base64-inlined by esbuild (see build.js inlineBlobsPlugin).
// In Node.js (tools/tests), they're loaded from eboot/blobs/ on disk.
//
// Assets:
//   datapsp.bin — PSP PRX module (MIPS ELF, type ET_SCE_RELEXEC) from
//   popstationr (GPL-2.0). This is a ~19 KB userspace launcher that the XMB
//   loads into the PSP's MIPS CPU to bootstrap the POPS emulator via the
//   scePopsMan kernel module.
//
//   The binary is NOT a stub — ARK-4 actually executes the MIPS code in .text.
//   Zeroing .text causes a hang at the POPS splash screen. It imports:
//     IoFileMgrForUser, ModuleMgrForUser, StdioForUser,
//     SysMemUserForUser, ThreadManForUser, scePopsMan
//
//   Every known EBOOT converter (pop-fe, PSX2PSP, popstationr, copstation)
//   ships this same binary. It was originally extracted from a Sony firmware
//   update and redistributed under GPL-2.0 by popstationr.
//
// STARTDAT components (header, logo PNG, PGD footer) are generated from
// scratch in psisoimg.js — no blobs needed for those.

/** Decode a base64 string to Uint8Array (used in browser builds). */
function b64decode(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const BLOB_NAMES = ['datapsp.bin'];
const blobs = {};

// Environment detection: Node.js reads from disk, browser reads base64 globals
// injected by the build system (see build.js inlineBlobsPlugin).
if (typeof process !== 'undefined' && process.versions?.node) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'blobs');
  for (const name of BLOB_NAMES) blobs[name] = new Uint8Array(readFileSync(join(dir, name)));
} else {
  for (const name of BLOB_NAMES) blobs[name] = b64decode(self['__BLOB_' + name]);
}

export const ASSETS = {
  /** Returns a fresh copy of the DATA.PSP ELF (caller may mutate it). */
  get dataPsp() { return new Uint8Array(blobs['datapsp.bin']); },
};
