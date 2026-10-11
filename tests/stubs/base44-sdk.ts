// Vitest alias target for `npm:@base44/sdk@0.8.40`. Delegates to whatever fake the current test installed.
export function createClientFromRequest(req: Request): unknown {
  const factory = (globalThis as unknown as { __base44Factory?: (r: Request) => unknown }).__base44Factory;
  if (!factory) throw new Error('No fake Base44 client installed: call installFakeBase44() in the test.');
  return factory(req);
}
