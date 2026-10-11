// In-memory stand-in for the Base44 SDK. Mimics the parts we rely on, including owner-only RLS:
// records are stamped with created_by_id on create and invisible to other users afterwards.

type Rec = Record<string, any> & { id: string };

export class FakeDb {
  private tables = new Map<string, Rec[]>();
  private counter = 0;
  private failures = new Map<string, Error>();

  /** Makes every `op` ("create" | "update") on `entity` throw `error`. */
  failOn(entity: string, op: 'create' | 'update', error: Error) {
    this.failures.set(`${entity}.${op}`, error);
  }

  private maybeFail(entity: string, op: string) {
    const err = this.failures.get(`${entity}.${op}`);
    if (err) throw err;
  }

  table(name: string): Rec[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  private now() {
    return new Date().toISOString();
  }

  seed(name: string, data: Record<string, any>, userId: string): Rec {
    const rec: Rec = { id: `${name.toLowerCase()}_${++this.counter}`, created_by_id: userId, created_date: this.now(), updated_date: this.now(), ...data };
    this.table(name).push(rec);
    return rec;
  }

  entity(name: string, userId: string) {
    const visible = () => this.table(name).filter((r) => r.created_by_id === userId);
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
    const sortRecs = (recs: Rec[], sort?: string) => {
      if (!sort) return recs;
      const desc = sort.startsWith('-');
      const key = desc ? sort.slice(1) : sort;
      return [...recs].sort((a, b) => (String(a[key] ?? '') < String(b[key] ?? '') ? -1 : 1) * (desc ? -1 : 1));
    };
    return {
      get: async (id: string) => {
        const rec = visible().find((r) => r.id === id);
        if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
        return clone(rec);
      },
      list: async (sort?: string, limit?: number) => clone(sortRecs(visible(), sort).slice(0, limit ?? 50)),
      filter: async (query: Record<string, unknown>, sort?: string, limit?: number) =>
        clone(
          sortRecs(
            visible().filter((r) => Object.entries(query).every(([k, v]) => r[k] === v)),
            sort,
          ).slice(0, limit ?? 50),
        ),
      create: async (data: Record<string, any>) => {
        this.maybeFail(name, 'create');
        const rec: Rec = { ...clone(data), id: `${name.toLowerCase()}_${++this.counter}`, created_by_id: userId, created_date: this.now(), updated_date: this.now() };
        this.table(name).push(rec);
        return clone(rec);
      },
      update: async (id: string, data: Record<string, any>) => {
        this.maybeFail(name, 'update');
        const rec = visible().find((r) => r.id === id);
        if (!rec) throw Object.assign(new Error('Not found'), { status: 404 });
        Object.assign(rec, clone(data), { updated_date: this.now() });
        return clone(rec);
      },
      delete: async (id: string) => {
        const list = this.table(name);
        const i = list.findIndex((r) => r.id === id && r.created_by_id === userId);
        if (i === -1) throw Object.assign(new Error('Not found'), { status: 404 });
        list.splice(i, 1);
        return { ok: true };
      },
    };
  }
}

/** Installs the fake SDK. The signed-in user comes from the `x-test-user` request header. */
export function installFakeBase44(db: FakeDb) {
  (globalThis as any).__base44Factory = (req: Request) => {
    const userId = req.headers.get('x-test-user');
    return {
      auth: { me: async () => (userId ? { id: userId, email: `${userId}@example.com` } : null) },
      entities: new Proxy({}, { get: (_t, name: string) => db.entity(name, userId ?? '__anonymous__') }),
    };
  };
}

export function post(body: unknown, user: string | null = 'user_1', method = 'POST'): Request {
  return new Request('https://app.test/functions/fn', {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}
