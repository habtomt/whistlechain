const fs = require('fs');
const path = require('path');
const createKeccakHash = require('keccak');

const CACHE_DIR = '/root/.cache/hardhat-nodejs/compilers-v2';
const VERSION = '0.8.24';
const LONG_VERSION = '0.8.24+commit.e11b9ed9';

function keccak256Hex(buf) {
  return '0x' + createKeccakHash('keccak256').update(buf).digest('hex');
}

// WASM (solc-js) entry: this is the one actually used 
const wasmDir = path.join(CACHE_DIR, 'wasm');
fs.mkdirSync(wasmDir, { recursive: true });

const soljsonSrc = require.resolve('solc/soljson.js');
const soljsonBuf = fs.readFileSync(soljsonSrc);
const wasmFileName = `soljson-v${VERSION}+commit.e11b9ed9.js`;
fs.copyFileSync(soljsonSrc, path.join(wasmDir, wasmFileName));

const wasmList = {
  builds: [
    {
      path: wasmFileName,
      version: VERSION,
      build: 'commit.e11b9ed9',
      longVersion: LONG_VERSION,
      keccak256: keccak256Hex(soljsonBuf),
      urls: [],
      platform: 'wasm',
    },
  ],
  releases: { [VERSION]: wasmFileName },
  latestRelease: VERSION,
};
fs.writeFileSync(path.join(wasmDir, 'list.json'), JSON.stringify(wasmList, null, 2));

// so Hardhat immediately falls back to the WASM build above, without ever
// trying to reach binaries.soliditylang.org.
const linuxDir = path.join(CACHE_DIR, 'linux-amd64');
fs.mkdirSync(linuxDir, { recursive: true });
const dummyFileName = `solc-v${VERSION}+commit.e11b9ed9`;
const dummyPath = path.join(linuxDir, dummyFileName);
fs.writeFileSync(dummyPath, '#!/bin/sh\nexit 1\n');
fs.chmodSync(dummyPath, 0o755);
fs.writeFileSync(dummyPath + '.does.not.work', '');

const linuxList = {
  builds: [
    {
      path: dummyFileName,
      version: VERSION,
      build: 'commit.e11b9ed9',
      longVersion: LONG_VERSION,
      keccak256: keccak256Hex(fs.readFileSync(dummyPath)),
      urls: [],
      platform: 'linux-amd64',
    },
  ],
  releases: { [VERSION]: dummyFileName },
  latestRelease: VERSION,
};
fs.writeFileSync(path.join(linuxDir, 'list.json'), JSON.stringify(linuxList, null, 2));

console.log('Solc compiler cache prepared at', CACHE_DIR);
