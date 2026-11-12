import { execFileSync } from 'node:child_process';

/**
 * Opt-in bridge to an isolated PostgreSQL fixture. This runs the repository's real
 * SQL/RPC functions; it does not reimplement the action or reply state machines.
 * No .env file or remote database connection is read.
 */
export class RuntimePostgresClientFixture {
  constructor(
    readonly container: string,
    readonly database: string,
  ) {
    if (!/^cake-runtime-pg-[\w-]+$/.test(container))
      throw new Error('Runtime acceptance requires an isolated test container');
    if (!/^cake_projection_[\w]+$/.test(database))
      throw new Error('Runtime acceptance requires an isolated test database');
    const inspected = JSON.parse(
      execFileSync('docker', ['inspect', container], { encoding: 'utf8', timeout: 5000 }),
    ) as Array<{ HostConfig: { NetworkMode: string; PortBindings: unknown } }>;
    if (
      inspected[0]?.HostConfig.NetworkMode !== 'none' ||
      Object.keys(inspected[0]?.HostConfig.PortBindings ?? {}).length > 0
    )
      throw new Error('Runtime acceptance container must have no network or published ports');
  }

  query<T = unknown>(statement: string): T {
    const result = execFileSync(
      'docker',
      [
        'exec',
        '-i',
        this.container,
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '-U',
        'postgres',
        '-d',
        this.database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        input: `SET statement_timeout='5s';\n${statement}\n`,
        encoding: 'utf8',
        timeout: 10000,
      },
    ).trim();
    return (result ? JSON.parse(result) : null) as T;
  }

  rpc(name: string, input: Record<string, unknown>) {
    const parameters: Record<string, string[]> = {
      transition_agent_action: ['p_operation', 'p_input'],
      transition_agent_reply_turn: ['p_operation', 'p_input'],
      append_agent_reply_callback: ['p_input'],
    };
    const names = parameters[name];
    if (!names || Object.keys(input).some((key) => !names.includes(key)))
      throw new Error('Unsupported runtime fixture RPC');
    const values = names.map((key) => {
      const value = input[key];
      return `${key} => ${typeof value === 'object' ? `${sql(JSON.stringify(value))}::jsonb` : sql(value)}`;
    });
    return {
      abortSignal: async (_signal: AbortSignal) => ({
        data: this.query(`SELECT public.${name}(${values.join(',')})::text;`),
        error: null,
      }),
    };
  }

  from(table: string) {
    if (!['agent_action_records', 'agent_action_evidence', 'agent_reply_turns'].includes(table))
      throw new Error('Unsupported runtime fixture table');
    return new RuntimePostgresSelect(this, table);
  }
}

class RuntimePostgresSelect {
  private columns = '*';
  private readonly conditions: string[] = [];
  private readonly ordering: string[] = [];
  private rowLimit = 25;

  constructor(
    private readonly client: RuntimePostgresClientFixture,
    private readonly table: string,
  ) {}

  select(columns: string) {
    if (columns !== '*' && !/^[a-z_]+(?:,[a-z_]+)*$/.test(columns))
      throw new Error('Unsupported fixture projection');
    this.columns = columns;
    return this;
  }
  eq(column: string, value: unknown) {
    this.conditions.push(`${field(column)} = ${sql(value)}`);
    return this;
  }
  neq(column: string, value: unknown) {
    this.conditions.push(`${field(column)} <> ${sql(value)}`);
    return this;
  }
  lte(column: string, value: unknown) {
    this.conditions.push(`${field(column)} <= ${sql(value)}`);
    return this;
  }
  gt(column: string, value: unknown) {
    this.conditions.push(`${field(column)} > ${sql(value)}`);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.conditions.push(`${field(column)} IN (${values.map(sql).join(',')})`);
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error('Unsupported fixture predicate');
    this.conditions.push(`${field(column)} IS NOT NULL`);
    return this;
  }
  or(predicate: string) {
    if (
      predicate !== 'status.in.(executing,unknown),and(status.eq.succeeded,local_sync.eq.pending)'
    )
      throw new Error('Unsupported fixture disjunction');
    this.conditions.push(
      "(status IN ('executing','unknown') OR (status='succeeded' AND local_sync='pending'))",
    );
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.ordering.push(`${field(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }
  limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 25)
      throw new Error('Runtime fixture queries require a bounded row limit');
    this.rowLimit = value;
    return this;
  }
  async abortSignal(_signal: AbortSignal) {
    const where = this.conditions.length ? `WHERE ${this.conditions.join(' AND ')}` : '';
    const order = this.ordering.length ? `ORDER BY ${this.ordering.join(',')}` : '';
    return {
      data: this.client.query<unknown[]>(
        `SELECT coalesce(json_agg(rows),'[]'::json) FROM (SELECT ${this.columns} FROM public.${this.table} ${where} ${order} LIMIT ${this.rowLimit}) rows;`,
      ),
      error: null,
    };
  }
}

function field(value: string): string {
  if (!/^[a-z_]+(?:(?:->|->>)[a-z_]+)*$/.test(value))
    throw new Error('Unsupported runtime fixture field');
  return value.replace(/(->>?)([a-z_]+)/g, "$1'$2'");
}

export function sql(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'string') throw new Error('Unsupported runtime fixture value');
  return `'${value.replace(/'/g, "''")}'`;
}
