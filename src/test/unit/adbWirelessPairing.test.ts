import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAdbPairingAddress,
  parseAdbMdnsPairingServices,
} from '../../extension/commands/device/adbWirelessPairing';

test('parseAdbMdnsPairingServices parses and deduplicates pairing addresses', () => {
  const output = [
    'List of discovered mdns services',
    'adb-f000b3bb-7pKC7U\t_adb-tls-pairing._tcp\t192.168.31.34:40999',
    'adb-f000b3bb-7pKC7U\t_adb-tls-pairing._tcp\t192.168.31.34:40999',
    'adb-R5CT72HXJZK-HfKqJl\t_adb-tls-pairing._tcp\t192.168.31.105:42045',
  ].join('\n');

  assert.deepEqual(parseAdbMdnsPairingServices(output), [
    '192.168.31.34:40999',
    '192.168.31.105:42045',
  ]);
});

test('parseAdbMdnsPairingServices ignores connect services', () => {
  const output = [
    'adb-f000b3bb-7pKC7U\t_adb-tls-connect._tcp\t192.168.31.34:41501',
    'adb-R5CT72HXJZK-HfKqJl\t_adb-tls-connect._tcp\t192.168.31.105:35111',
  ].join('\n');

  assert.deepEqual(parseAdbMdnsPairingServices(output), []);
});

test('normalizeAdbPairingAddress validates host and port', () => {
  assert.equal(normalizeAdbPairingAddress('192.168.31.105:42045'), '192.168.31.105:42045');
  assert.equal(normalizeAdbPairingAddress('example.local:12345'), 'example.local:12345');
});

test('normalizeAdbPairingAddress rejects invalid or unsafe input', () => {
  assert.equal(normalizeAdbPairingAddress(''), null);
  assert.equal(normalizeAdbPairingAddress('192.168.31.105'), null);
  assert.equal(normalizeAdbPairingAddress('192.168.31.105:0'), null);
  assert.equal(normalizeAdbPairingAddress('192.168.31.105:70000'), null);
  assert.equal(normalizeAdbPairingAddress('192.168.31.105:42045 & dir'), null);
});
