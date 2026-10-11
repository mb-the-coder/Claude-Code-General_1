export const ROOT: string;
export const FUNCTION_NAMES: string[];
export const ENTITY_NAMES: string[];
export const FRONTEND_FILES: string[];
export function bundleFunction(
  name: string,
  options?: { alias?: Record<string, string>; external?: string[]; minify?: boolean },
): Promise<string>;
export function findUnresolvedImports(code: string): string[];
