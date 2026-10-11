export const ROOT: string;
export const FUNCTION_NAMES: string[];
export const ENTITY_NAMES: string[];
export const FRONTEND_FILES: string[];
export const NPM_DEPS: string[];
export function npmSpecifier(pkg: string): string;
export function bundleFunction(
  name: string,
  options?: { alias?: Record<string, string>; external?: string[]; minify?: boolean; npmDeps?: boolean },
): Promise<string>;
export function findUnresolvedImports(code: string): string[];
export function frontendImportGraph(entry?: string, options?: { root?: string }): Promise<string[]>;
