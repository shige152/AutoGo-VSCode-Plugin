const ADB_TLS_PAIRING_SERVICE = '_adb-tls-pairing._tcp';

export function normalizeAdbPairingAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /[;&|`<>]/.test(trimmed)) {
    return null;
  }

  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return `${match[1]}:${match[2]}`;
}

export function parseAdbMdnsPairingServices(output: string): string[] {
  const addresses = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    if (!line.includes(ADB_TLS_PAIRING_SERVICE)) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    for (const part of parts) {
      const address = normalizeAdbPairingAddress(part);
      if (address) {
        addresses.add(address);
      }
    }
  }

  return Array.from(addresses);
}
