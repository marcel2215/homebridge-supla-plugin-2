#!/usr/bin/env node

/* global process, console */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const nativeDir = path.join(projectRoot, 'native');
const libraryDir = path.join(nativeDir, 'supla-client-lib');
const helperSource = path.join(nativeDir, 'supla-native-bridge.c');
const outputDir = path.join(nativeDir, 'bin');
const outputBinary = path.join(outputDir, process.platform === 'win32' ? 'supla-native-bridge.exe' : 'supla-native-bridge');
const optionalBuild = process.argv.includes('--optional');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  });

  return result;
}

function getPkgConfigFlags(flag) {
  const result = run('pkg-config', [flag, 'openssl']);
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

if (!statSync(helperSource, { throwIfNoEntry: false })) {
  const message = `Missing helper source: ${helperSource}`;
  if (optionalBuild) {
    console.warn(`${message}; skipping optional native helper build.`);
    process.exit(0);
  }

  console.error(message);
  process.exit(1);
}

if (!statSync(libraryDir, { throwIfNoEntry: false })) {
  const message = `Missing native library directory: ${libraryDir}`;
  if (optionalBuild) {
    console.warn(`${message}; skipping optional native helper build.`);
    process.exit(0);
  }

  console.error(message);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const compiler = process.env.CC || 'cc';
const cSources = readdirSync(libraryDir)
  .filter((entry) => entry.endsWith('.c'))
  .map((entry) => path.join(libraryDir, entry));

const compileArgs = [
  '-O2',
  '-Wall',
  '-Wextra',
  '-DNOMYSQL=1',
  '-D__LOG_CALLBACK=1',
  '-I', libraryDir,
];

if (process.platform === 'darwin') {
  compileArgs.push('-D_DARWIN_C_SOURCE', '-include', 'sys/types.h');
}

compileArgs.push(...getPkgConfigFlags('--cflags'));
compileArgs.push(helperSource, ...cSources);

const linkArgs = [
  ...getPkgConfigFlags('--libs'),
  '-lssl',
  '-lcrypto',
  '-lpthread',
  '-o',
  outputBinary,
];

// Deduplicate linker flags while keeping order.
const dedupedLinkArgs = [];
const seen = new Set();
for (const arg of linkArgs) {
  const key = arg;
  if (seen.has(key)) {
    continue;
  }
  seen.add(key);
  dedupedLinkArgs.push(arg);
}

const result = spawnSync(compiler, [...compileArgs, ...dedupedLinkArgs], {
  stdio: 'inherit',
  cwd: projectRoot,
});

if (result.status !== 0) {
  if (optionalBuild) {
    console.warn('Failed to build optional SUPLA native helper binary; continuing without native helper.');
    process.exit(0);
  }

  console.error('Failed to build SUPLA native helper binary.');
  process.exit(result.status ?? 1);
}

if (process.platform !== 'win32') {
  chmodSync(outputBinary, 0o755);
}

console.log(`Built SUPLA native helper: ${outputBinary}`);
