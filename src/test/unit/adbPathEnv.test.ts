import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdbPathInjectedEnv, isAgExecutableCommand } from '../../utils/adbPathEnv';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autogo-adb-path-'));
}

test('createAdbPathInjectedEnv prepends configured adb directory and removes competing adb entries', () => {
  const tempDir = createTempDir();

  try {
    const configuredDir = path.join(tempDir, 'configured-platform-tools');
    const competingDir = path.join(tempDir, 'competing-platform-tools');
    const keepDir = path.join(tempDir, 'keep');
    fs.mkdirSync(configuredDir);
    fs.mkdirSync(competingDir);
    fs.mkdirSync(keepDir);
    fs.writeFileSync(path.join(configuredDir, 'adb.exe'), 'configured');
    fs.writeFileSync(path.join(competingDir, 'adb.exe'), 'competing');

    const baseEnv = {
      Path: [competingDir, configuredDir, keepDir].join(path.delimiter),
    };

    const result = createAdbPathInjectedEnv(path.join(configuredDir, 'adb.exe'), baseEnv);
    const pathEntries = result.env.Path?.split(path.delimiter) || [];

    assert.equal(result.injected, true);
    assert.equal(pathEntries[0], configuredDir);
    assert.equal(pathEntries.includes(competingDir), false);
    assert.equal(pathEntries.includes(keepDir), true);
    assert.equal(pathEntries.filter((entry) => entry === configuredDir).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createAdbPathInjectedEnv ignores bare adb command names', () => {
  const result = createAdbPathInjectedEnv('adb', { PATH: 'original-path' });

  assert.equal(result.injected, false);
  assert.equal(result.reason, 'bare-adb-command');
  assert.equal(result.env.PATH, 'original-path');
});

test('createAdbPathInjectedEnv accepts current-directory adb paths when directory exists', () => {
  const result = createAdbPathInjectedEnv(`.${path.sep}adb`, { PATH: 'original-path' });
  const pathEntries = result.env.PATH?.split(path.delimiter) || [];

  assert.equal(result.injected, true);
  assert.equal(pathEntries[0], '.');
});

test('isAgExecutableCommand detects AG executable paths', () => {
  assert.equal(isAgExecutableCommand('C:\\Users\\Public\\ag.exe'), true);
  assert.equal(isAgExecutableCommand('/Users/Shared/ag'), true);
  assert.equal(isAgExecutableCommand('adb.exe'), false);
});
