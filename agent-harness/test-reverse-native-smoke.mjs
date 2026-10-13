#!/usr/bin/env node
/** Unit checks for the harness. These do not substitute for real native OCI smoke. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportedNodeVersion, verifyIntegrity, verifyElfArchitecture, nativeArch } from './reverse-toolchain-check.mjs';
import { assertNativePlatform, ghidraProfile, SIZE_CEILING_MIB, LIMITS } from './reverse-native-common.mjs';
import { processTable, providerProcesses, sanitizeProcess, trackOwnedProcesses, rawOutputCapture, isGhidraAnalysisProcess, ghidraAnalysisStarted, remainingProcesses } from './reverse-native-process.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const linuxProc=process.platform==='linux'&&existsSync('/proc/self/stat');
let gccAvailable=false;
try {execFileSync('gcc',['--version'],{stdio:'ignore'});gccAvailable=true;} catch {}
const native={arch:'amd64',hostPlatform:'linux',hostArch:'x64',daemonOs:'linux',daemonArch:'x86_64',imageOs:'linux',imageArch:'amd64'};
test('exact REA engine range rejects unsupported intervening majors and prereleases',()=>{
  for (const version of ['22.19.0','22.20.0','24.11.0','24.19.0','26.0.0','27.0.0']) assert(supportedNodeVersion(version),version);
  for (const version of ['22.18.9','23.1.0','24.10.9','25.0.0','21.99.0','26.0.0-rc.1','v24.19.0','24.11']) assert(!supportedNodeVersion(version),version);
});
test('SRI hashes the actual downloaded bytes',()=>{
  const bytes=Buffer.from('public fixture tarball bytes');
  const sri='sha512-'+createHash('sha512').update(bytes).digest('base64');
  assert(verifyIntegrity(bytes,sri));
  assert.throws(()=>verifyIntegrity(Buffer.from('modified bytes'),sri),/integrity mismatch/);
  assert.throws(()=>verifyIntegrity(bytes,'sha256-'+createHash('sha256').update(bytes).digest('base64')),/pinned SHA-512/);
});
test('ELF header must be little-endian 64-bit and architecture matched',()=>{
  const elf=Buffer.alloc(64); Buffer.from([127,69,76,70,2,1]).copy(elf); elf.writeUInt16LE(62,18);
  assert(verifyElfArchitecture(elf,'amd64'));
  assert.throws(()=>verifyElfArchitecture(elf,'arm64'),/machine mismatch/);
  elf.writeUInt16LE(183,18); assert(verifyElfArchitecture(elf,'arm64'));
  elf[4]=1; assert.throws(()=>verifyElfArchitecture(elf,'arm64'),/ELF64/);
  assert.throws(()=>verifyElfArchitecture(Buffer.from('not ELF'),'amd64'),/not ELF/);
});
test('native proof rejects QEMU-style host/daemon/image mismatches and unsupported OS',()=>{
  assert.doesNotThrow(()=>assertNativePlatform(native));
  assert.equal(nativeArch('aarch64'),'arm64');
  for (const changed of [{arch:'arm64'},{hostArch:'arm64'},{daemonArch:'aarch64'},{imageArch:'arm64'},{hostPlatform:'darwin'},{daemonOs:'windows'},{imageOs:'windows'}]) assert.throws(()=>assertNativePlatform({...native,...changed}));
  assert.throws(()=>nativeArch('riscv64'),/unsupported/);
});
test('workflow evidence must carry upstream pinned Ghidra identity',()=>{
  const profile={provider:{id:'ghidra',version:'12.1.4'}};
  assert.equal(ghidraProfile({analysis_profile:{provider:{id:'rea-workflow'},parameters:{upstream_analysis_profile:profile}}}),profile);
  assert.throws(()=>ghidraProfile({analysis_profile:{provider:{id:'hopper',version:'12.1.4'}}}),/bind Ghidra/);
  assert.throws(()=>ghidraProfile({analysis_profile:{provider:{id:'ghidra',version:'12.1.3'}}}),/version mismatch/);
});
test('Linux proc parser reads current identity and does not label ordinary node as REA',{skip:linuxProc?false:'requires Linux procfs; pure ownership tests still run'},()=>{
  const own=processTable().find(row=>row.pid===process.pid);
  assert(own && own.start && own.pgid>0 && own.ppid>0);
  assert.equal(providerProcesses([own]).length,0);
  assert.equal(sanitizeProcess({...own,cmd:'node secret-bearing arbitrary argv'}).cmd,undefined);
  assert.equal(providerProcesses([{comm:'java',cmd:'java'},{comm:'node',cmd:'/opt/deepsonar/bin/rea analyze sample'}]).length,2);
});
test('image, helper, and harness pin the same production limits and native build surface',()=>{
  const dockerfile=readFileSync(join(root,'deploy/Dockerfile.agent-reverse'),'utf8');
  assert.equal((dockerfile.match(/GHIDRA_HEADLESS_MAXMEM=1536m/g)??[]).length,2);
  assert(dockerfile.includes('--integrity "$rea_tarball" "$REA_AGENTS_INTEGRITY"'));
  assert(dockerfile.includes('COPY --from=ghidra-native'));
  const nativeBuilder=readFileSync(join(root,'agent-harness/reverse-ghidra-native.sh'),'utf8');
  assert(nativeBuilder.includes('ARCH_TYPE= OSDIR=linux_arm_64'));
  assert(nativeBuilder.includes('--elf "$binary" "$arch"'));
  assert.equal(SIZE_CEILING_MIB,2800); assert.equal(LIMITS.memory_bytes,4096*1024*1024);
});
test('public ELF and shared-library fixtures compile reproducibly with host gcc',{skip:process.platform!=='linux'?'native ELF compiler fixture check requires Linux':(!gccAvailable?'host gcc unavailable; mandatory Docker smoke never skips':false)},()=>{
  const temporary=mkdtempSync(join(tmpdir(),'reverse-fixture-unit-'));
  try {
    for (const [name,extra] of [['sample_elf',['-no-pie']],['libsample.so',['-fPIC','-shared']]]) {
      const binary=join(temporary,name);
      const argv=['-O0','-g','-fno-inline','-fno-builtin','-Wl,--build-id=none','-ffile-prefix-map='+join(root,'agent-harness/fixtures/reverse-sample/sample.c')+'=/src/sample.c',...extra,join(root,'agent-harness/fixtures/reverse-sample/sample.c'),'-o',binary];
      execFileSync('gcc',argv); const first=readFileSync(binary); execFileSync('gcc',argv);
      assert(first.equals(readFileSync(binary)),name);
    }
  } finally {rmSync(temporary,{recursive:true,force:true});}
});

test('isolated REA dependency closure locks exact root and every downloaded artifact',()=>{
  const pkg=JSON.parse(readFileSync(join(root,'agent-harness/rea-runtime/package.json'),'utf8'));
  const lock=JSON.parse(readFileSync(join(root,'agent-harness/rea-runtime/package-lock.json'),'utf8'));
  assert.equal(pkg.dependencies['rea-agents'],'6.4.0');
  assert.equal(lock.packages[''].dependencies['rea-agents'],'6.4.0');
  assert.equal(lock.packages['node_modules/rea-agents'].version,'6.4.0');
  assert.equal(lock.packages['node_modules/rea-agents'].integrity,'sha512-Vj1zWfSlna5bphGoaoI/TcVBuYvze9u+OyPC3Shz8YkBqaCTqB4COnnRoX7XDwMpwI24ZlFEel2yEj0k8LTWEQ==');
  for (const [name,entry] of Object.entries(lock.packages).filter(([name])=>name)) {
    assert.match(entry.resolved,/^https:\/\/registry\.npmjs\.org\//,name);
    assert.match(entry.integrity,/^sha512-/,name);
    assert(!entry.hasInstallScript,`${name} requires an install script incompatible with ignore-scripts`);
  }
  assert(readFileSync(join(root,'deploy/Dockerfile.agent-reverse'),'utf8').includes('npm ci --omit=dev --ignore-scripts'));
});

test('process ownership never refreshes start identity or adopts descendants of reused PIDs',()=>{
  const row=(pid,ppid,start)=>({pid,ppid,start,comm:'node',pgid:pid,state:'S',cmd:'public fixture'});
  const known=new Map();
  const first=trackOwnedProcesses(known,[row(10,1,'100'),row(11,10,'110')],10,1);
  assert.equal(first.length,2);
  const reused=trackOwnedProcesses(known,[row(10,1,'200'),row(11,10,'210'),row(12,11,'220')],10,1);
  assert.equal(reused.length,0);
  assert.equal(known.get(10).start,'100'); assert.equal(known.get(11).start,'110');
  assert.equal(known.has(12),false);
});
test('raw output preserves split UTF-8 exactly and counts original bytes',()=>{
  const capture=rawOutputCapture(); const bytes=Buffer.from('pseudocode π € 漢字');
  for (const byte of bytes) assert(capture.append('out',Buffer.from([byte])));
  assert(capture.buffer('out').equals(bytes)); assert.equal(capture.bytes('out'),bytes.length);
  assert.equal(capture.buffer('out').toString('utf8'),'pseudocode π € 漢字');
  const bounded=rawOutputCapture(4);
  assert(bounded.append('out',Buffer.from('abc')));
  assert.equal(bounded.append('err',Buffer.from('def')),false);
  assert.equal(bounded.bytes('out')+bounded.bytes('err'),6);
  assert.equal(bounded.buffer('out').length+bounded.buffer('err').length,4);
});

test('cancellation requires actual Ghidra analysis log, never a Java version or LaunchSupport probe',()=>{
  const row=cmd=>({comm:'java',cmd});
  assert.equal(isGhidraAnalysisProcess(row('java -version')),false);
  assert.equal(isGhidraAnalysisProcess(row('java -cp LaunchSupport.jar LaunchSupport -envvars')),false);
  const actual=row('java -cp Utility.jar ghidra.Ghidra ghidra.app.util.headless.AnalyzeHeadless -log /tmp/rea-ghidra-fixture/ghidra.log');
  assert(isGhidraAnalysisProcess(actual));
  assert.equal(ghidraAnalysisStarted(actual,()=> 'Headless startup complete'),false);
  assert(ghidraAnalysisStarted(actual,()=> 'INFO ANALYZING all memory and code: public fixture'));
});

test('cleanup rejects an ordinary live owned descendant regardless of provider process name',()=>{
  const child={pid:123,ppid:99,start:'777',comm:'sleep',cmd:'sleep 1000',state:'S',pgid:123};
  const known=new Map([[child.pid,child]]);
  assert.deepEqual(remainingProcesses(known,[child]),[child]);
  assert.deepEqual(remainingProcesses(known,[{...child,start:'888'}]),[]);
  const java={...child,pid:124,start:'889',comm:'java',cmd:'java'};
  assert.deepEqual(remainingProcesses(known,[java]),[java]);
});
