import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutoGoRemotePairingAddress } from '../../extension/commands/device/autoGoRemotePairing';

test('normalizeAutoGoRemotePairingAddress converts 5-digit pairing code to AutoGo address', () => {
  assert.equal(normalizeAutoGoRemotePairingAddress('19790'), 'api.autogo.cc:19790');
});

test('normalizeAutoGoRemotePairingAddress keeps full host and port address', () => {
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790'), 'api.autogo.cc:19790');
});

test('normalizeAutoGoRemotePairingAddress rejects invalid values', () => {
  assert.equal(normalizeAutoGoRemotePairingAddress(''), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790;dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790&dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790|dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790`dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790<dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:19790>dir'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('not-a-code'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:0'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:65536'), null);
  assert.equal(normalizeAutoGoRemotePairingAddress('api.autogo.cc:999999'), null);
});
