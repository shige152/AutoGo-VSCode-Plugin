import * as fs from 'fs';
import * as path from 'path';

export type AdbPathEnvSkipReason =
  | 'empty-adb-path'
  | 'bare-adb-command'
  | 'missing-adb-dir'
  | 'path-processing-error';

export interface AdbPathEnvResult {
  env: NodeJS.ProcessEnv;
  injected: boolean;
  adbDir?: string;
  reason?: AdbPathEnvSkipReason;
  error?: unknown;
}

export function isAgExecutableCommand(command: string): boolean {
  const normalizedCommand = command.trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  const executableName = normalizedCommand.split(/[\\/]/).pop() || normalizedCommand;
  return executableName === 'ag.exe' || executableName === 'ag';
}

export function createAdbPathInjectedEnv(
  adbPath: string | undefined | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): AdbPathEnvResult {
  const env = { ...baseEnv };
  const normalizedAdbPath = (adbPath || '').trim().replace(/^"(.*)"$/, '$1');

  if (!normalizedAdbPath) {
    return { env, injected: false, reason: 'empty-adb-path' };
  }

  if (isBareAdbCommand(normalizedAdbPath)) {
    return { env, injected: false, reason: 'bare-adb-command' };
  }

  try {
    const adbDir = path.dirname(normalizedAdbPath);
    if (!fs.existsSync(adbDir)) {
      return { env, injected: false, adbDir, reason: 'missing-adb-dir' };
    }

    const envPathKey = getEnvPathKey(env);
    const currentPath = env[envPathKey] || '';
    const adbExeName = path.basename(normalizedAdbPath);
    const adbDirNormalized = normalizePathEntry(adbDir);
    const filteredEntries: string[] = [];

    for (const entry of currentPath.split(path.delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }

      const entryValue = trimmed.replace(/^"(.*)"$/, '$1');
      const entryNormalized = normalizePathEntry(entryValue);
      if (!entryNormalized) {
        continue;
      }
      if (entryNormalized === adbDirNormalized) {
        continue;
      }
      if (hasAdbBinary(entryValue, adbExeName)) {
        continue;
      }
      filteredEntries.push(trimmed);
    }

    env[envPathKey] = [adbDir, ...filteredEntries].join(path.delimiter);
    return { env, injected: true, adbDir };
  } catch (error) {
    return { env, injected: false, reason: 'path-processing-error', error };
  }
}

function getEnvPathKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      return key;
    }
  }
  return 'PATH';
}

function isBareAdbCommand(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === 'adb' || normalized === 'adb.exe';
}

function normalizePathEntry(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/[\\/]+$/, '').toLowerCase();
}

function hasAdbBinary(dir: string, adbExeName: string): boolean {
  if (!dir) {
    return false;
  }
  try {
    return fs.existsSync(path.join(dir, adbExeName));
  } catch {
    return false;
  }
}
