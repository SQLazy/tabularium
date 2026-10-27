export function verifyExport(
  exp: unknown,
  pubHex: string,
): Promise<{ ok: boolean; errors: string[]; entries: number }>;
