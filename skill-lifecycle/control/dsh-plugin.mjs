import { randomUUID } from 'node:crypto';
import { compute } from './table-compute.mjs';
import { stopRun } from './stop-run.mjs';

const admittedNames = Object.freeze(['skill', 'trial_read', 'trial_compute', 'trial_write_report']);
const computeLimits = Object.freeze({ maxOperations: 1, maxFilters: 4 });
const identityFields = ['runId', 'batchId', 'sessionId', 'skillDigest', 'inputDigest',
  'evaluatorDigest', 'environmentDigest', 'policyDigest'];

function failure(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Bounded identity view for the audit trail: identifiers and sizes only, never content.
const argViews = Object.freeze({
  trial_read: args => Object.freeze({
    fileId: typeof args?.fileId === 'string' ? args.fileId : null,
    offset: Number.isSafeInteger(args?.offset) ? args.offset : null,
    limit: Number.isSafeInteger(args?.limit) ? args.limit : null,
  }),
  trial_compute: args => Object.freeze({
    operation: typeof args?.operation === 'string' ? args.operation : null,
    tableId: typeof args?.tableId === 'string' ? args.tableId : null,
    column: typeof args?.column === 'string' ? args.column : null,
    weightColumn: typeof args?.weightColumn === 'string' ? args.weightColumn : null,
    filterCount: Array.isArray(args?.filters) ? args.filters.length : null,
  }),
  trial_write_report: args => Object.freeze({
    contentBytes: typeof args?.content === 'string' ? Buffer.byteLength(args.content, 'utf8') : null,
  }),
});

function viewArgs(tool, args) {
  return argViews[tool]?.(args) ?? {};
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw failure(`INVALID_INSTALL_OPTIONS: ${label}`);
  return value;
}

function validateBindingShape(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== identityFields.length) {
    throw failure('INVALID_INSTALL_OPTIONS: binding');
  }
  for (const key of identityFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || !descriptor.value.trim()) {
      throw failure('INVALID_INSTALL_OPTIONS: binding');
    }
  }
}

function validateOptions(options) {
  if (!isRecord(options)) throw failure('INVALID_INSTALL_OPTIONS');
  const { agent, binding, run, files, budget, defineTool, requestIdentity, measureRequest,
    audit, allowedSkillNames, waitMs = 5000 } = options;
  validateBindingShape(binding);
  if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string' || !agent.id.trim()) {
    throw failure('INVALID_INSTALL_OPTIONS: agent');
  }
  const ctx = agent.ctx;
  if (ctx === null || typeof ctx !== 'object' ||
    typeof ctx.tools?.register !== 'function' || typeof ctx.tools?.guard !== 'function' ||
    typeof ctx.on !== 'function') throw failure('INVALID_INSTALL_OPTIONS: agent.ctx');
  if (!isRecord(run) || typeof run.assertAdmitted !== 'function' || typeof run.assertBinding !== 'function' ||
    typeof run.snapshot !== 'function') throw failure('INVALID_INSTALL_OPTIONS: run');
  if (!isRecord(files) || typeof files.read !== 'function' ||
    typeof files.writeReport !== 'function' || typeof files.drain !== 'function') {
    throw failure('INVALID_INSTALL_OPTIONS: files');
  }
  if (!(options.tables instanceof Map) || options.tables.size === 0) {
    throw failure('INVALID_INSTALL_OPTIONS: tables');
  }
  if (!isRecord(budget) || typeof budget.reserve !== 'function' || typeof budget.settle !== 'function' ||
    typeof budget.markUnknown !== 'function' || typeof budget.snapshot !== 'function') {
    throw failure('INVALID_INSTALL_OPTIONS: budget');
  }
  requireFunction(defineTool, 'defineTool');
  requireFunction(requestIdentity, 'requestIdentity');
  requireFunction(measureRequest, 'measureRequest');
  requireFunction(audit, 'audit');
  if (allowedSkillNames !== undefined &&
    (!Array.isArray(allowedSkillNames) || allowedSkillNames.length === 0 ||
      allowedSkillNames.some(name => typeof name !== 'string' || !name.trim()))) {
    throw failure('INVALID_INSTALL_OPTIONS: allowedSkillNames');
  }
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0) throw failure('INVALID_INSTALL_OPTIONS: waitMs');
  if (options.waitForIdle !== undefined) requireFunction(options.waitForIdle, 'waitForIdle');
  const skillNames = new Set(allowedSkillNames ?? []);
  return { waitMs, skillNames };
}

export async function installTrialControl(options) {
  const { waitMs, skillNames } = validateOptions(options);
  const { agent, run, binding, files, tables, budget, defineTool, requestIdentity,
    measureRequest, audit } = options;
  const disposers = [];
  const capabilities = Object.freeze(skillNames.size > 0
    ? [...admittedNames]
    : admittedNames.filter(name => name !== 'skill'));
  let disposed = false;

  function dispose() {
    if (disposed) return;
    disposed = true;
    let firstError;
    while (disposers.length > 0) {
      try {
        disposers.pop()();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  function record(entry) {
    audit(Object.freeze({ ...entry }));
  }

  function instrument(tool, call) {
    return async (args, exec) => {
      try {
        run.assertAdmitted(binding);
        const value = await call(args, exec);
        record({ kind: 'tool_call', tool, callId: exec?.callId ?? null, ok: true, ...viewArgs(tool, args) });
        return value;
      } catch (error) {
        record({ kind: 'tool_call', tool, callId: exec?.callId ?? null, ok: false,
          code: error?.code ?? 'ERROR', ...viewArgs(tool, args) });
        throw error;
      }
    };
  }

  const tools = [
    defineTool({
      name: 'trial_read',
      description: 'Read approved input or frozen skill content by its issued file ID.',
      parameters: {
        fileId: { type: 'string', required: true },
        offset: { type: 'integer', required: true },
        limit: { type: 'integer', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          fileId: { type: 'string' }, content: { type: 'string' }, sha256: { type: 'string' },
          totalBytes: { type: 'integer' }, truncated: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: instrument('trial_read', args => files.read(args)),
    }),
    defineTool({
      name: 'trial_compute',
      description: 'Run one fixed aggregate over host-approved tables. No code, paths or URLs. '
        + 'operation must be one of sum|mean|min|max|count|weighted_mean. '
        + 'Set tableId to the registered table id; pass column for sum|mean|min|max|weighted_mean, '
        + 'plus weightColumn for weighted_mean; count takes no column. '
        + 'filters is an optional array of {column, op, value} where op is "eq" or "ne" and value is always a string.',
      parameters: {
        operation: { type: 'string', required: true },
        tableId: { type: 'string', required: true },
        column: { type: 'string' },
        weightColumn: { type: 'string' },
        filters: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          column: { type: 'string' }, op: { type: 'string' }, value: { type: 'string' } } } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {
          operation: { type: 'string' }, value: { type: 'number' }, numericMode: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: instrument('trial_compute', args => compute(args, tables, computeLimits)),
    }),
    defineTool({
      name: 'trial_write_report',
      description: 'Publish the fixed validation report artifact. No output path parameter.',
      parameters: { content: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          artifactId: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: instrument('trial_write_report', args => files.writeReport(args)),
    }),
  ];
  const guard = exec => {
    if (exec?.agent !== agent) return undefined;
    if (!capabilities.includes(exec.name)) {
      record({ kind: 'tool_denied', tool: String(exec.name), reason: 'TOOL_NOT_ALLOWED' });
      return `TOOL_NOT_ALLOWED: ${String(exec.name)}`;
    }
    if (exec.name === 'skill' && (typeof exec.arguments?.name !== 'string' ||
      !skillNames.has(exec.arguments.name))) {
      record({ kind: 'tool_denied', tool: 'skill', reason: 'SKILL_NOT_ALLOWED' });
      return `SKILL_NOT_ALLOWED: ${String(exec.arguments?.name)}`;
    }
    try {
      run.assertAdmitted(binding);
    } catch (error) {
      const code = error?.code ?? 'RUN_NOT_RUNNING';
      record({ kind: 'tool_denied', tool: exec.name, reason: code });
      return code;
    }
    if (exec.name === 'skill') {
      // The native loader is owned by another plugin; only its admission is ours to record.
      record({ kind: 'tool_admitted', tool: 'skill', skillName: exec.arguments.name });
    }
    return undefined;
  };

  const streamListener = (request, next) => (async function* controlled() {
    const identity = await requestIdentity(request);
    if (!identity || identity.runId !== binding.runId || identity.sessionId !== binding.sessionId) {
      record({ kind: 'request_denied', reason: 'REQUEST_NOT_OWNED' });
      throw failure('REQUEST_NOT_OWNED');
    }
    let requestBytes;
    try {
      requestBytes = measureRequest(request);
    } catch (error) {
      record({ kind: 'request_denied', reason: 'REQUEST_UNMEASURABLE' });
      throw failure('REQUEST_UNMEASURABLE', error);
    }
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) {
      record({ kind: 'request_denied', reason: 'REQUEST_UNMEASURABLE' });
      throw failure('REQUEST_UNMEASURABLE');
    }
    try {
      run.assertAdmitted(binding);
    } catch (error) {
      const code = error?.code ?? 'RUN_NOT_RUNNING';
      record({ kind: 'request_denied', reason: code });
      throw error;
    }
    const attemptId = `attempt-${randomUUID()}`;
    const maxOutputTokens = request?.maxTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      record({ kind: 'request_denied', reason: 'OUTPUT_BOUND_MISSING' });
      throw failure('OUTPUT_BOUND_MISSING');
    }
    try {
      await budget.reserve({ attemptId, requestBytes, maxOutputTokens });
    } catch (error) {
      record({ kind: 'request_denied', reason: error?.code ?? 'RESERVE_FAILED' });
      throw error;
    }
    record({ kind: 'request_reserved', attemptId, requestBytes });
    let usage = null;
    let outcome = null;
    try {
      for await (const chunk of await next()) {
        // The harness reports usage as full samples; the last sample wins.
        if (chunk && chunk.type === 'usage' && isRecord(chunk.usage)) usage = chunk.usage;
        yield chunk;
      }
      const inputTokens = usage === null ? null : tokenCount(usage.inputTokens);
      const outputTokens = usage === null ? null : tokenCount(usage.outputTokens);
      if (inputTokens === null || outputTokens === null) {
        const reason = usage === null ? 'usage_missing' : 'usage_invalid';
        await budget.markUnknown({ attemptId, reason });
        outcome = reason;
        record({ kind: 'request_unresolved', attemptId, reason });
      } else {
        const sample = { inputTokens, outputTokens };
        const cacheRead = tokenCount(usage.cacheReadTokens);
        const cacheWrite = tokenCount(usage.cacheWriteTokens);
        if (cacheRead !== null) sample.cacheReadTokens = cacheRead;
        if (cacheWrite !== null) sample.cacheWriteTokens = cacheWrite;
        await budget.settle({ attemptId, usage: sample });
        outcome = 'settled';
        record({ kind: 'request_settled', attemptId, inputTokens, outputTokens });
      }
    } catch (error) {
      await budget.markUnknown({ attemptId, reason: 'stream_error' });
      outcome = 'stream_error';
      record({ kind: 'request_failed', attemptId, code: error?.code ?? 'ERROR' });
      throw error;
    } finally {
      // An abandoned or cancelled stream must not leave a silent in-flight reservation.
      if (outcome === null) {
        try {
          await budget.markUnknown({ attemptId, reason: 'stream_abandoned' });
          record({ kind: 'request_unresolved', attemptId, reason: 'stream_abandoned' });
        } catch {
          // Keep the original failure reason; the ledger stays sticky on its own fault.
        }
      }
    }
  })();

  try {
    for (const tool of tools) disposers.push(agent.ctx.tools.register(tool));
    disposers.push(agent.ctx.tools.guard(guard));
    disposers.push(agent.ctx.on('llm/stream', streamListener));
  } catch (error) {
    dispose();
    throw error;
  }

  return Object.freeze({
    admittedTools: () => capabilities,
    dispose,
    async stop(reason) {
      try {
        return await stopRun({ run, binding, agent, io: files, reason,
          waitMs, waitForIdle: options.waitForIdle ?? (target => target.whenIdle()), budget });
      } finally {
        dispose();
      }
    },
  });
}
