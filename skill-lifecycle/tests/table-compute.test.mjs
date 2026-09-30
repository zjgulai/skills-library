import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, compute } from '../control/table-compute.mjs';
import { openRun } from '../control/run-state.mjs';
import { openFiles } from '../control/bounded-files.mjs';
import { makeTempCase } from './fixtures.mjs';

const csvLimits = { maxBytes: 4096, maxRows: 20, maxColumns: 8, maxCellChars: 128 };
const computeLimits = { maxOperations: 1, maxFilters: 4 };

test('CSV fields preserve quoted commas, escaped quotes and embedded line breaks', () => {
  const actual = parseCsv('name,note\r\n"A,B","said ""yes""\nnext"\r\nC,last\r\n', csvLimits);
  assert.deepEqual(actual.headers, ['name', 'note']);
  assert.deepEqual(actual.rows, [['A,B', 'said "yes"\nnext'], ['C', 'last']]);
});

function tableMap(text = 'segment,value,weight\nA,10,2\nB,40,1\nA,-5,1\n') {
  return new Map([['metrics', { ...parseCsv(text, csvLimits), sha256: 'a'.repeat(64) }]]);
}

function aggregate(operation, extra = {}) {
  return { operation, tableId: 'metrics', ...(operation === 'count' ? {} : { column: 'value' }),
    ...(operation === 'weighted_mean' ? { weightColumn: 'weight' } : {}), filters: [], ...extra };
}

test('CSV preserves BOM handling, trailing empty fields and header-only tables', () => {
  assert.deepEqual(parseCsv('\ufeffa,b\n1,\n2,""', csvLimits), {
    headers: ['a', 'b'], rows: [['1', ''], ['2', '']],
  });
  assert.deepEqual(parseCsv('a,b\n', csvLimits), { headers: ['a', 'b'], rows: [] });
  assert.deepEqual(parseCsv('a\n""', csvLimits), { headers: ['a'], rows: [['']] });
});

test('empty lines are data, not silently skipped', () => {
  assert.deepEqual(parseCsv('a\n\n', csvLimits), { headers: ['a'], rows: [['']] });
  assert.throws(() => parseCsv('a,b\n\n', csvLimits), /CSV_ROW_WIDTH/);
});

test('malformed quoting, row widths and headers fail explicitly', () => {
  for (const [text, code] of [
    ['a,b\n"x,y', /CSV_UNCLOSED_QUOTE/],
    ['a,b\nx"y,z', /CSV_QUOTE_POSITION/],
    ['a,b\n"x" y,z', /CSV_AFTER_QUOTE/],
    ['a,b\n1,2,3', /CSV_ROW_WIDTH/],
    ['a,b\n1', /CSV_ROW_WIDTH/],
    ['a,a\n1,2', /CSV_HEADER/],
    ['a, \n1,2', /CSV_HEADER/],
    ['', /CSV_HEADER/], ['\ufeff', /CSV_HEADER/],
    ['a,b\r1,2', /CSV_LINE_ENDING/],
  ]) assert.throws(() => parseCsv(text, csvLimits), code);
});

test('CSV enforces byte, row, column and decoded-cell limits at the boundary', () => {
  const text = 'a\n中';
  assert.equal(Buffer.byteLength(text), 5);
  assert.deepEqual(parseCsv(text, { ...csvLimits, maxBytes: 5, maxRows: 1, maxColumns: 1, maxCellChars: 1 }).rows, [['中']]);
  assert.throws(() => parseCsv(text, { ...csvLimits, maxBytes: 4 }), /CSV_BYTES_LIMIT/);
  assert.throws(() => parseCsv('a\n1\n2', { ...csvLimits, maxRows: 1 }), /CSV_ROWS_LIMIT/);
  assert.throws(() => parseCsv('a,b\n1,2', { ...csvLimits, maxColumns: 1 }), /CSV_COLUMNS_LIMIT/);
  assert.throws(() => parseCsv('a\n"xx"', { ...csvLimits, maxCellChars: 1 }), /CSV_CELL_LIMIT/);
  assert.deepEqual(parseCsv('a\n"𝄞"', { ...csvLimits, maxCellChars: 1 }).rows, [['𝄞']]);
  assert.deepEqual(parseCsv('a', { ...csvLimits, maxRows: 0 }).rows, []);
});

test('CSV requires explicit finite limits and well-formed string input', () => {
  for (const input of [null, 123, Buffer.from('a\n1'), 'a\n\ud800', 'a\n\0']) {
    assert.throws(() => parseCsv(input, csvLimits), /INVALID_CSV/);
  }
  for (const limits of [null, {}, { ...csvLimits, maxBytes: Infinity },
    { ...csvLimits, maxRows: -1 }, { ...csvLimits, maxColumns: 0 },
    { ...csvLimits, maxCellChars: 0.5 }, { ...csvLimits, extra: true }]) {
    assert.throws(() => parseCsv('a\n1', limits), /INVALID_LIMIT/);
  }
});

test('CSV output is deeply frozen so its caller cannot alter parsed rows', () => {
  const table = parseCsv('a,b\n1,2', csvLimits);
  assert.throws(() => { table.headers[0] = 'changed'; }, TypeError);
  assert.throws(() => { table.rows[0][0] = '999'; }, TypeError);
  assert.throws(() => table.rows.push(['3', '4']), TypeError);
});

for (const [operation, left, right, expected] of [
  ['add', 1.25, 2.5, 3.75], ['subtract', 1, 3, -2],
  ['multiply', -2, 75, -150], ['divide', 1, 4, 0.25],
]) {
  test(`scalar ${operation} has no table or IO dependency`, () => {
    const receipt = compute({ operation, left, right }, new Map(), computeLimits);
    assert.equal(receipt.value, expected);
    assert.equal(receipt.operation, operation);
    assert.equal(receipt.tableDigest, null);
    assert.equal(receipt.matchedRows, null);
    assert.deepEqual(receipt.request, { operation, left, right });
    assert.equal(receipt.numericMode, 'ieee754-binary64');
  });
}

for (const [operation, expected] of [
  ['sum', 45], ['mean', 15], ['min', -5], ['max', 40], ['count', 3], ['weighted_mean', 13.75],
]) {
  test(`table ${operation} uses data and returns a scoped receipt`, () => {
    const request = aggregate(operation);
    const receipt = compute(request, tableMap(), computeLimits);
    assert.equal(receipt.value, expected);
    assert.equal(receipt.matchedRows, 3);
    assert.equal(receipt.tableDigest, 'a'.repeat(64));
    assert.deepEqual(receipt.request, request);
  });
}

test('filters use exact string equality and AND semantics without numeric coercion', () => {
  const tables = tableMap('segment,value,weight\n01,10,1\n1,20,2\n01,30,3');
  assert.equal(compute(aggregate('sum', { filters: [{ column: 'segment', op: 'eq', value: '01' }] }), tables, computeLimits).value, 40);
  assert.equal(compute(aggregate('sum', { filters: [
    { column: 'segment', op: 'ne', value: '1' }, { column: 'weight', op: 'eq', value: '3' },
  ] }), tables, computeLimits).value, 30);
  assert.equal(compute(aggregate('count', { filters: [{ column: 'segment', op: 'eq', value: 'absent' }] }), tables, computeLimits).value, 0);
});

test('empty aggregations fail while count returns zero', () => {
  const tables = tableMap('segment,value,weight');
  assert.equal(compute(aggregate('count'), tables, computeLimits).value, 0);
  for (const operation of ['sum', 'mean', 'min', 'max', 'weighted_mean']) {
    assert.throws(() => compute(aggregate(operation), tables, computeLimits), /EMPTY_SELECTION/);
  }
});

test('count does not require numeric cells and reports do not expose raw rows', () => {
  const tables = tableMap('segment,value,weight\nprivate-cell,not-numeric,none');
  const result = compute(aggregate('count'), tables, computeLimits);
  assert.equal(result.value, 1);
  assert.equal(JSON.stringify(result).includes('private-cell'), false);
});

test('non-decimal, blank and non-finite values are not silently treated as numbers', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', '1e3', '12%', '=1+1', '1,000', '1_000']) {
    const tables = new Map([['metrics', { headers: ['value'], rows: [[value]], sha256: 'a'.repeat(64) }]]);
    assert.throws(() => compute(aggregate('sum'), tables, computeLimits), /INVALID_NUMBER/);
  }
  for (const value of [null, false, undefined, {}, NaN, Infinity]) {
    assert.throws(() => compute({ operation: 'add', left: value, right: 1 }, new Map(), computeLimits), /INVALID_NUMBER/);
  }
});

test('negative values, explicit decimals and percentages over 100 remain valid', () => {
  const tables = tableMap('segment,value,weight\nA,-10.5,1\nB,150.25,1');
  assert.equal(compute(aggregate('sum'), tables, computeLimits).value, 139.75);
  assert.equal(compute({ operation: 'add', left: '+.5', right: '-0.25' }, new Map(), computeLimits).value, 0.25);
});

test('zero division and invalid weights cannot create a misleading finite result', () => {
  for (const right of [0, -0, '0', '-0.00']) {
    assert.throws(() => compute({ operation: 'divide', left: 1, right }, new Map(), computeLimits), /DIVISION_BY_ZERO/);
  }
  assert.throws(() => compute(aggregate('weighted_mean'), tableMap('segment,value,weight\nA,1,-1'), computeLimits), /INVALID_WEIGHT/);
  assert.throws(() => compute(aggregate('weighted_mean'), tableMap('segment,value,weight\nA,1,0'), computeLimits), /ZERO_WEIGHT/);
});

test('unsupported operations and code-like extra fields are rejected', () => {
  for (const request of [
    { operation: 'eval', code: 'process.env' }, { operation: 'fetch', url: 'https://example.invalid' },
    { operation: 'sql', query: 'select 1' }, { operation: 'read', path: '/private' },
  ]) assert.throws(() => compute(request, tableMap(), computeLimits), /OPERATION_NOT_ALLOWED/);
  for (const request of [null, [], {},
    { operation: 'add', left: 1, right: 2, path: '/private' },
    { ...aggregate('sum'), code: '1+1' },
    { ...aggregate('count'), column: 'value' },
    { ...aggregate('sum'), weightColumn: 'weight' },
  ]) assert.throws(() => compute(request, tableMap(), computeLimits), /INVALID_REQUEST/);
});

test('unknown tables, columns and malformed digests are not guessed', () => {
  const tables = tableMap();
  assert.throws(() => compute({ ...aggregate('sum'), tableId: 'missing' }, tables, computeLimits), /TABLE_NOT_ALLOWED/);
  assert.throws(() => compute({ ...aggregate('sum'), column: 'missing' }, tables, computeLimits), /COLUMN_NOT_FOUND/);
  assert.throws(() => compute({ ...aggregate('weighted_mean'), weightColumn: 'missing' }, tables, computeLimits), /COLUMN_NOT_FOUND/);
  const malformed = new Map([['metrics', { ...parseCsv('value\n1', csvLimits), sha256: 'fake' }]]);
  assert.throws(() => compute(aggregate('sum'), malformed, computeLimits), /INVALID_TABLE/);
});

test('filters reject unsupported operators, extra fields and missing columns even on empty tables', () => {
  const tables = tableMap('segment,value,weight');
  for (const filter of [null, { column: 'segment', op: 'contains', value: 'A' },
    { column: 'segment', op: 'eq', value: 1 },
    { column: 'segment', op: 'eq', value: 'A', code: 'true' }]) {
    assert.throws(() => compute(aggregate('count', { filters: [filter] }), tables, computeLimits), /INVALID_FILTER/);
  }
  assert.throws(() => compute(aggregate('count', { filters: [{ column: 'missing', op: 'eq', value: '' }] }), tables, computeLimits), /COLUMN_NOT_FOUND/);
});

test('operation and filter limits are checked before calculation', () => {
  assert.throws(() => compute({ operation: 'add', left: 1, right: 1 }, new Map(), { maxOperations: 0, maxFilters: 0 }), /OPERATION_LIMIT/);
  assert.throws(() => compute(aggregate('sum', { filters: [{ column: 'segment', op: 'eq', value: 'A' }] }), tableMap(),
    { maxOperations: 1, maxFilters: 0 }), /FILTER_LIMIT/);
  for (const limits of [{}, { maxOperations: Infinity, maxFilters: 4 }, { maxOperations: 1, maxFilters: -1 }]) {
    assert.throws(() => compute({ operation: 'add', left: 1, right: 1 }, new Map(), limits), /INVALID_LIMIT/);
  }
});

test('unsafe magnitude, hidden decimal rounding and arithmetic overflow are rejected', () => {
  for (const value of [9007199254740992, '9007199254740993', '9007199254740990.5', '0.1234567890123456']) {
    assert.throws(() => compute({ operation: 'add', left: value, right: 0 }, new Map(), computeLimits), /NUMERIC_RANGE/);
  }
  assert.throws(() => compute({ operation: 'multiply', left: Number.MAX_SAFE_INTEGER, right: 2 }, new Map(), computeLimits), /NUMERIC_RANGE/);
  assert.throws(() => compute({ operation: 'divide', left: 1e-200, right: 1e200 }, new Map(), computeLimits), /NUMERIC_RANGE/);
  assert.equal(compute({ operation: 'add', left: Number.MAX_SAFE_INTEGER, right: 0 }, new Map(), computeLimits).value, Number.MAX_SAFE_INTEGER);
});

test('receipt deep copies request and never mutates inputs', () => {
  const tables = tableMap();
  const request = aggregate('sum', { filters: [{ column: 'segment', op: 'eq', value: 'A' }] });
  const before = JSON.stringify([...tables]);
  const result = compute(request, tables, computeLimits);
  request.filters[0].value = 'B';
  assert.equal(result.request.filters[0].value, 'A');
  assert.throws(() => { result.request.filters[0].value = 'changed'; }, TypeError);
  assert.equal(JSON.stringify([...tables]), before);
});

test('explicit null or undefined filters are rejected instead of widening the selection', () => {
  for (const filters of [null, undefined, {}, '']) {
    assert.throws(() => compute(aggregate('sum', { filters }), tableMap(), computeLimits), /INVALID_FILTER/);
  }
  const request = aggregate('sum');
  delete request.filters;
  assert.equal(compute(request, tableMap(), computeLimits).value, 45);
});

test('sparse filters cannot silently bypass a selection constraint', () => {
  const filters = Array(1);
  assert.throws(() => compute(aggregate('sum', { filters }), tableMap(), computeLimits), /INVALID_FILTER/);
});

test('table rows and headers must be dense arrays with regular string cells', () => {
  for (const table of [
    { headers: ['value'], rows: [Array(1)] },
    { headers: ['value'], rows: Array(1) },
    { headers: Array(1), rows: [['1']] },
    { headers: ['value', 'value'], rows: [['1', '2']] },
    { headers: ['value'], rows: [[1]] },
    { headers: ['value'], rows: [['1', '2']] },
    { headers: ['value'], rows: [['\ud800']] },
  ]) {
    assert.throws(() => compute(aggregate('count'), new Map([['metrics', { ...table, sha256: 'a'.repeat(64) }]]), computeLimits), /INVALID_TABLE/);
  }
});

test('request, filter and table getters are rejected without being called', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls += 1; return 1; } };
  const request = { operation: 'add', left: 1, right: 1 };
  Object.defineProperty(request, 'left', getter);
  assert.throws(() => compute(request, new Map(), computeLimits), /INVALID_REQUEST/);
  const operation = { left: 1, right: 1 };
  Object.defineProperty(operation, 'operation', getter);
  assert.throws(() => compute(operation, new Map(), computeLimits), /INVALID_REQUEST/);
  const filter = { column: 'segment', op: 'eq', value: 'A' };
  Object.defineProperty(filter, 'value', getter);
  assert.throws(() => compute(aggregate('sum', { filters: [filter] }), tableMap(), computeLimits), /INVALID_FILTER/);
  const filters = [];
  Object.defineProperty(filters, '0', getter);
  assert.throws(() => compute(aggregate('sum', { filters }), tableMap(), computeLimits), /INVALID_FILTER/);
  const table = { headers: ['value'], rows: [['1']], sha256: 'a'.repeat(64) };
  Object.defineProperty(table.rows[0], '0', getter);
  assert.throws(() => compute(aggregate('count'), new Map([['metrics', table]]), computeLimits), /INVALID_TABLE/);
  assert.equal(calls, 0);
});

test('symbol or hidden request fields cannot carry unrecorded arguments', () => {
  const hidden = { operation: 'add', left: 1, right: 1 };
  Object.defineProperty(hidden, 'secret', { value: 'hidden' });
  const symbolic = { operation: 'add', left: 1, right: 1, [Symbol('hidden')]: true };
  for (const request of [hidden, symbolic]) {
    assert.throws(() => compute(request, new Map(), computeLimits), /INVALID_REQUEST/);
  }
});

test('special header names are literal columns and do not modify prototypes', () => {
  const tables = new Map([['metrics', {
    ...parseCsv('__proto__,constructor\n1,2\n3,4', csvLimits), sha256: 'b'.repeat(64),
  }]]);
  assert.equal(compute({ operation: 'sum', tableId: 'metrics', column: '__proto__', filters: [] }, tables, computeLimits).value, 4);
  assert.equal(compute({ operation: 'sum', tableId: 'metrics', column: 'constructor', filters: [] }, tables, computeLimits).value, 6);
  assert.equal(Object.hasOwn(Object.prototype, 'value'), false);
});

test('CSV byte limits count BOM and quoted newline cells without normalizing input', () => {
  const text = '\ufeffa,b\r\n"x\r\ny","z"';
  const result = parseCsv(text, { ...csvLimits, maxBytes: Buffer.byteLength(text) });
  assert.deepEqual(result.rows, [['x\r\ny', 'z']]);
  assert.throws(() => parseCsv(text, { ...csvLimits, maxBytes: Buffer.byteLength(text) - 1 }), /CSV_BYTES_LIMIT/);
});

test('numeric validation applies to selected cells without mutating other rows', () => {
  const tables = tableMap('segment,value,weight\nA,5,1\nB,not-a-number,1');
  const result = compute(aggregate('sum', { filters: [{ column: 'segment', op: 'eq', value: 'A' }] }), tables, computeLimits);
  assert.equal(result.value, 5);
  assert.equal(result.matchedRows, 1);
  assert.equal(tables.get('metrics').rows[1][1], 'not-a-number');
  assert.throws(() => compute(aggregate('sum'), tables, computeLimits), /INVALID_NUMBER/);
});

test('weighted mean with zero weights keeps row counts and does not divide by zero', () => {
  const result = compute(aggregate('weighted_mean'), tableMap('segment,value,weight\nA,99,0\nB,5,2'), computeLimits);
  assert.equal(result.value, 5);
  assert.equal(result.matchedRows, 2);
});

test('scalar operation ignores table availability but never invokes supplied table accessors', () => {
  const tables = { get() { throw new Error('must not inspect tables'); } };
  assert.equal(compute({ operation: 'add', left: 1, right: 2 }, tables, computeLimits).value, 3);
});

test('T01 and T02 snapshots feed a pure calculation and a verified local report', async (t) => {
  const f = await makeTempCase(t);
  const run = f.track(await openRun({ root: f.trusted, binding: f.binding }));
  await run.start();
  const io = f.track(await openFiles({ run, binding: f.binding, inputRoot: f.inputs,
    skillRoot: f.skill, outputRoot: f.outputs, files: f.inputFiles,
    limits: { maxInputBytes: 4096, maxReportBytes: 4096 } }));
  const source = await io.read({ fileId: 'metrics', offset: 0, limit: 4096 });
  assert.equal(source.truncated, false);
  const table = { ...parseCsv(source.content, csvLimits), sha256: source.sha256 };
  const result = compute(aggregate('weighted_mean'), new Map([['metrics', table]]), computeLimits);
  assert.equal(result.value, 20);
  assert.equal(result.matchedRows, 2);
  assert.equal(result.tableDigest, source.sha256);
  const content = `Verified weighted mean: ${result.value}\nSource: ${result.tableDigest}\n`;
  const artifact = await io.writeReport({ content });
  assert.equal((await io.read({ fileId: 'validation-report', offset: 0, limit: 4096 })).sha256, artifact.sha256);
  assert.equal(await readFile(join(f.outputs, 'validation-report.md'), 'utf8'), content);
});

test('quoted empty fields, trailing commas and escaped final quotes retain their positions', () => {
  for (const [text, expected] of [
    ['a,b\n,', [['', '']]],
    ['a,b\n"",""\n', [['', '']]],
    ['a,b\n"x""",tail', [['x"', 'tail']]],
    ['a,b\n"""",tail', [['"', 'tail']]],
    ['a,b\nleft,right\nleft,', [['left', 'right'], ['left', '']]],
  ]) assert.deepEqual(parseCsv(text, csvLimits).rows, expected);
});

test('deterministic CSV round trips preserve a bounded set of literal field values', () => {
  const values = ['', 'plain', '中𝄞', 'a,b', '"', 'x\ny', 'x\r\ny', ' a ', '=1+1'];
  const quote = value => `"${value.replaceAll('"', '""')}"`;
  for (const left of values) {
    for (const right of values) {
      const csv = `left,right\r\n${quote(left)},${quote(right)}\r\n`;
      assert.deepEqual(parseCsv(csv, csvLimits).rows, [[left, right]]);
    }
  }
});

test('parser retains explicit spaces and delimiters instead of guessing another dialect', () => {
  assert.deepEqual(parseCsv(' label ,value\n A ,2', csvLimits), {
    headers: [' label ', 'value'], rows: [[' A ', '2']],
  });
  assert.deepEqual(parseCsv('single\na;b\na\tb', csvLimits).rows, [['a;b'], ['a\tb']]);
  assert.throws(() => parseCsv('a,b\n"x"\t,y', csvLimits), /CSV_AFTER_QUOTE/);
});

test('formula and command strings stay inert text and cannot be numeric expressions', () => {
  const csv = 'value\n"=SUM(1,2)"\n"process.exit()"\n"$(touch pwned)"';
  const table = parseCsv(csv, csvLimits);
  assert.deepEqual(table.rows, [['=SUM(1,2)'], ['process.exit()'], ['$(touch pwned)']]);
  const tables = new Map([['metrics', { ...table, sha256: 'c'.repeat(64) }]]);
  assert.equal(compute(aggregate('count'), tables, computeLimits).value, 3);
  assert.throws(() => compute(aggregate('sum'), tables, computeLimits), /INVALID_NUMBER/);
});

test('unknown array properties and hidden data are rejected before filtering', () => {
  const filters = [{ column: 'segment', op: 'eq', value: 'A' }];
  filters.extra = 'unrecorded';
  assert.throws(() => compute(aggregate('sum', { filters }), tableMap(), computeLimits), /INVALID_FILTER/);
  const table = { headers: ['value'], rows: [['1']], sha256: 'a'.repeat(64) };
  Object.defineProperty(table.rows[0], '0', { value: '1', enumerable: false });
  assert.throws(() => compute(aggregate('count'), new Map([['metrics', table]]), computeLimits), /INVALID_TABLE/);
});

test('CSV limit getter cannot execute while validating configuration', () => {
  let invoked = false;
  const limits = { ...csvLimits };
  Object.defineProperty(limits, 'maxBytes', { enumerable: true, get() { invoked = true; return 4096; } });
  assert.throws(() => parseCsv('a\n1', limits), /INVALID_LIMIT/);
  assert.equal(invoked, false);
});

test('aggregation does not lose a small value when large opposite values cancel', () => {
  const tables = tableMap('segment,value,weight\nA,1000000000000000,1\nB,0.1,1\nC,-1000000000000000,1');
  assert.equal(compute(aggregate('sum'), tables, computeLimits).value, 0.1);
  assert.equal(compute(aggregate('mean'), tables, computeLimits).value, 0.1 / 3);
  assert.equal(compute(aggregate('weighted_mean'), tables, computeLimits).value, 0.1 / 3);
});

test('aggregation is stable across permutations of cancellation-heavy inputs', () => {
  const rows = [['1000000000000000', '0.1', '-1000000000000000'],
    ['0.1', '-1000000000000000', '1000000000000000'],
    ['-1000000000000000', '1000000000000000', '0.1']];
  for (const values of rows) {
    const tables = tableMap(`segment,value,weight\n${values.map((value, i) => `${i},${value},1`).join('\n')}`);
    assert.equal(compute(aggregate('sum'), tables, computeLimits).value, 0.1);
  }
});

test('nonzero underflow is rejected using operands within the supported range', () => {
  assert.throws(() => compute({ operation: 'multiply', left: 1e-200, right: 1e-200 }, new Map(), computeLimits), /NUMERIC_RANGE/);
  assert.throws(() => compute({ operation: 'divide', left: Number.MIN_VALUE, right: 2 }, new Map(), computeLimits), /NUMERIC_RANGE/);
  const tiny = `0.${'0'.repeat(199)}1`;
  const tables = new Map([['metrics', { headers: ['value', 'weight'], rows: [[tiny, tiny]], sha256: 'd'.repeat(64) }]]);
  assert.throws(() => compute(aggregate('weighted_mean'), tables, computeLimits), /NUMERIC_RANGE/);
});

test('decimal precision rules accept exact safe integers and reject ambiguous fractions', () => {
  assert.equal(compute({ operation: 'add', left: '9007199254740991.000', right: 0 }, new Map(), computeLimits).value, Number.MAX_SAFE_INTEGER);
  assert.equal(compute({ operation: 'add', left: '000.125000', right: '.875' }, new Map(), computeLimits).value, 1);
  assert.throws(() => compute({ operation: 'add', left: '9007199254740991.01', right: 0 }, new Map(), computeLimits), /NUMERIC_RANGE/);
});
