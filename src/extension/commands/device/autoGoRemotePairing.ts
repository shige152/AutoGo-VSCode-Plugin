const DEFAULT_AUTOGO_REMOTE_HOST = 'api.autogo.cc';

export function normalizeAutoGoRemotePairingAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /[;&|`<>]/.test(trimmed)) {
    return null;
  }

  if (/^\d{5}$/.test(trimmed)) {
    return `${DEFAULT_AUTOGO_REMOTE_HOST}:${trimmed}`;
  }

  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(trimmed);
  if (match) {
    const port = Number(match[2]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return trimmed;
    }
  }

  return null;
}
