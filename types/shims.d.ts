// Ambient declarations for the Deno runtime that Base44 backend functions run on.
// They let `tsc` (running under Node) type-check the function sources without Deno installed.

declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function resolveDns(
    query: string,
    recordType: 'A' | 'AAAA',
  ): Promise<string[]>;
}

declare module 'npm:@base44/sdk@0.8.40' {
  // Minimal surface used by OmniCompetitor. The real SDK is provided by Base44 at runtime.
  export interface Base44Entity<T = Record<string, unknown>> {
    get(id: string): Promise<T & EntityMeta>;
    list(sort?: string, limit?: number): Promise<Array<T & EntityMeta>>;
    filter(
      query: Record<string, unknown>,
      sort?: string,
      limit?: number,
    ): Promise<Array<T & EntityMeta>>;
    create(data: Partial<T>): Promise<T & EntityMeta>;
    update(id: string, data: Partial<T>): Promise<T & EntityMeta>;
    delete(id: string): Promise<unknown>;
  }
  export interface EntityMeta {
    id: string;
    created_by_id?: string;
    created_date?: string;
    updated_date?: string;
  }
  export interface Base44Client {
    auth: { me(): Promise<{ id: string; email?: string } | null> };
    entities: {
      CompanyProfile: Base44Entity<any>;
      Competitor: Base44Entity<any>;
      BenchmarkReport: Base44Entity<any>;
    };
  }
  export function createClientFromRequest(req: Request): Base44Client;
}
