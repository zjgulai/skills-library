const scalarOps = new Set(['add', 'subtract', 'multiply', 'divide']);
const tableOps = new Set(['sum', 'mean', 'min', 'max', 'count', 'weighted_mean']);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function record(value, required, optional, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw failure(code);
  const fields = new Set([...required, ...optional]);
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!fields.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    copy[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(copy, key))) throw failure(code);
  return copy;
}

function limitsOf(value, fields, allowZero = []) {
  const limits = record(value, fields, [], 'INVALID_LIMIT');
  for (const field of fields) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < (allowZero.includes(field) ? 0 : 1)) {
      throw failure('INVALID_LIMIT');
    }
  }
  return limits;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseCsv(text, limits) {
  const bounds = limitsOf(limits, ['maxBytes', 'maxRows', 'maxColumns', 'maxCellChars'], ['maxRows']);
  if (typeof text !== 'string' || !text.isWellFormed() || text.includes('\0')) throw failure('INVALID_CSV');
  if (Buffer.byteLength(text, 'utf8') > bounds.maxBytes) throw failure('CSV_BYTES_LIMIT');
  const records = [];
  let row = [];
  let field = '';
  let fieldChars = 0;
  let mode = 'start';
  let rowStarted = false;

  function append(char) {
    fieldChars += 1;
    if (fieldChars > bounds.maxCellChars) throw failure('CSV_CELL_LIMIT');
    field += char;
  }

  function endField() {
    row.push(field);
    if (row.length > bounds.maxColumns) throw failure('CSV_COLUMNS_LIMIT');
    field = '';
    fieldChars = 0;
    mode = 'start';
  }

  function endRow() {
    endField();
    if (records.length === 0) {
      if (row.some(name => !name.trim()) || new Set(row).size !== row.length) throw failure('CSV_HEADER');
    } else {
      if (row.length !== records[0].length) throw failure('CSV_ROW_WIDTH');
      if (records.length > bounds.maxRows) throw failure('CSV_ROWS_LIMIT');
    }
    records.push(row);
    row = [];
    rowStarted = false;
  }

  for (let i = text.startsWith('\ufeff') ? 1 : 0; i < text.length; i += 1) {
    const char = String.fromCodePoint(text.codePointAt(i));
    if (char.length === 2) i += 1;
    rowStarted = true;
    if (mode === 'quoted') {
      if (char === '"') mode = 'after-quote';
      else append(char);
    } else if (char === '"') {
      if (mode === 'start') mode = 'quoted';
      else if (mode === 'after-quote') { append('"'); mode = 'quoted'; }
      else throw failure('CSV_QUOTE_POSITION');
    } else if (char === ',') {
      endField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (text[i + 1] !== '\n') throw failure('CSV_LINE_ENDING');
        i += 1;
      }
      endRow();
    } else {
      if (mode === 'after-quote') throw failure('CSV_AFTER_QUOTE');
      append(char);
      mode = 'bare';
    }
  }
  if (mode === 'quoted') throw failure('CSV_UNCLOSED_QUOTE');
  if (rowStarted) endRow();
  if (records.length === 0) throw failure('CSV_HEADER');
  return freeze({ headers: records[0], rows: records.slice(1) });
}

function numeric(value) {
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw failure('INVALID_NUMBER');
    const canonical = value.replace(/^[+-]/, '');
    const [whole, fraction = ''] = canonical.split('.');
    const digits = `${whole}${fraction}`.replace(/^0+/, '').replace(/0+$/, '');
    if (fraction.replace(/0+$/, '') && digits.length > 15) throw failure('NUMERIC_RANGE');
    const number = Number(value);
    if (number === 0 && /[1-9]/.test(canonical)) throw failure('NUMERIC_RANGE');
    value = number;
  } else if (typeof value !== 'number') throw failure('INVALID_NUMBER');
  if (!Number.isFinite(value)) throw failure('INVALID_NUMBER');
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw failure('NUMERIC_RANGE');
  return value;
}

function checked(value, nonzero = false) {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (nonzero && value === 0)) {
    throw failure('NUMERIC_RANGE');
  }
  return Object.is(value, -0) ? 0 : value;
}

function scalar(operation, left, right) {
  switch (operation) {
    case 'add': return checked(left + right);
    case 'subtract': return checked(left - right);
    case 'multiply': return checked(left * right, left !== 0 && right !== 0);
    case 'divide':
      if (right === 0) throw failure('DIVISION_BY_ZERO');
      return checked(left / right, left !== 0);
    default: throw failure('OPERATION_NOT_ALLOWED');
  }
}

function sumAccumulator() {
  let sum = 0;
  let correction = 0;
  return {
    add(value) {
      const next = checked(sum + value);
      // Neumaier compensation preserves small terms when larger terms later cancel.
      const lost = Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      correction = checked(correction + lost);
      sum = next;
    },
    value() { return checked(sum + correction); },
  };
}

function denseArray(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failure(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw failure(code);
  const copy = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    copy.push(descriptor.value);
  }
  return copy;
}

function getTable(tables, tableId) {
  if (!(tables instanceof Map) || typeof tableId !== 'string' || !tables.has(tableId)) throw failure('TABLE_NOT_ALLOWED');
  const table = record(tables.get(tableId), ['headers', 'rows', 'sha256'], [], 'INVALID_TABLE');
  const headers = denseArray(table.headers, 'INVALID_TABLE');
  const rows = denseArray(table.rows, 'INVALID_TABLE').map(row => denseArray(row, 'INVALID_TABLE'));
  const validCell = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
  if (typeof table.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(table.sha256) ||
    headers.length === 0 || headers.some(value => !validCell(value) || !value.trim()) ||
    new Set(headers).size !== headers.length ||
    rows.some(row => row.length !== headers.length || row.some(value => !validCell(value)))) {
    throw failure('INVALID_TABLE');
  }
  return { headers, rows, sha256: table.sha256 };
}

export function compute(request, tables, limits) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype) throw failure('INVALID_REQUEST');
  const descriptor = Object.getOwnPropertyDescriptor(request, 'operation');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure('INVALID_REQUEST');
  const operation = descriptor.value;
  if (!scalarOps.has(operation) && !tableOps.has(operation)) throw failure('OPERATION_NOT_ALLOWED');
  const bounds = limitsOf(limits, ['maxOperations', 'maxFilters'], ['maxOperations', 'maxFilters']);
  const input = record(request, ['operation'], ['left', 'right', 'tableId', 'column', 'weightColumn', 'filters'], 'INVALID_REQUEST');
  if (bounds.maxOperations < 1) throw failure('OPERATION_LIMIT');
  if (scalarOps.has(operation)) {
    const clean = record(input, ['operation', 'left', 'right'], [], 'INVALID_REQUEST');
    const value = scalar(operation, numeric(clean.left), numeric(clean.right));
    return freeze({ operation, value, matchedRows: null, tableDigest: null,
      request: clean, numericMode: 'ieee754-binary64' });
  }
  const keys = ['operation', 'tableId'];
  if (operation !== 'count') keys.push('column');
  if (operation === 'weighted_mean') keys.push('weightColumn');
  const clean = record(input, keys, ['filters'], 'INVALID_REQUEST');
  const table = getTable(tables, clean.tableId);
  function column(name) {
    if (typeof name !== 'string' || !table.headers.includes(name)) throw failure('COLUMN_NOT_FOUND');
    return table.headers.indexOf(name);
  }
  const valueIndex = operation === 'count' ? undefined : column(clean.column);
  const weightIndex = operation === 'weighted_mean' ? column(clean.weightColumn) : undefined;
  const filters = Object.hasOwn(clean, 'filters') ? clean.filters : [];
  if (!Array.isArray(filters)) throw failure('INVALID_FILTER');
  if (filters.length > bounds.maxFilters) throw failure('FILTER_LIMIT');
  const comparisons = denseArray(filters, 'INVALID_FILTER').map(filter => {
    const item = record(filter, ['column', 'op', 'value'], [], 'INVALID_FILTER');
    if (!['eq', 'ne'].includes(item.op) || typeof item.value !== 'string') throw failure('INVALID_FILTER');
    return { ...item, index: column(item.column) };
  });
  clean.filters = comparisons.map(({ column: name, op, value }) => ({ column: name, op, value }));
  let matchedRows = 0;
  const sum = sumAccumulator();
  const weightSum = sumAccumulator();
  let minimum;
  let maximum;
  for (const row of table.rows) {
    if (!comparisons.every(filter => filter.op === 'eq' ? row[filter.index] === filter.value : row[filter.index] !== filter.value)) continue;
    matchedRows += 1;
    if (operation === 'count') continue;
    const value = numeric(row[valueIndex]);
    minimum = minimum === undefined ? value : Math.min(minimum, value);
    maximum = maximum === undefined ? value : Math.max(maximum, value);
    if (operation === 'weighted_mean') {
      const weight = numeric(row[weightIndex]);
      if (weight < 0) throw failure('INVALID_WEIGHT');
      sum.add(scalar('multiply', value, weight));
      weightSum.add(weight);
    } else if (operation === 'sum' || operation === 'mean') sum.add(value);
  }
  if (matchedRows === 0 && operation !== 'count') throw failure('EMPTY_SELECTION');
  if (operation === 'weighted_mean' && weightSum.value() === 0) throw failure('ZERO_WEIGHT');
  const value = operation === 'count' ? matchedRows : operation === 'min' ? minimum :
    operation === 'max' ? maximum : operation === 'mean' ? scalar('divide', sum.value(), matchedRows) :
      operation === 'weighted_mean' ? scalar('divide', sum.value(), weightSum.value()) : sum.value();
  return freeze({ operation, value, matchedRows, tableDigest: table.sha256,
    request: clean, numericMode: 'ieee754-binary64' });
}
