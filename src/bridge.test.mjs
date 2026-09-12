// src/bridge.test.mjs — engine-to-bridge adapter tests; no network or .env.

import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptEngineResponse, extract } from './bridge.mjs';

const CANONICAL =
  '{"payload": {"body": "\\u20ac329,000", "subject": "Listing agreement — Ruzafa", "to": "david@example.com"}, "type": "email"}';
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function engineResult(overrides = {}) {
  const action = {
    id: 'a1',
    type: 'email',
    title: 'Send the listing agreement',
    payload: {
      to: 'david@example.com',
      subject: 'Listing agreement — Ruzafa',
      body: '€329,000',
    },
    auto_execute: false,
  };
  return {
    turns: [{ id: 'L01', speaker: 'CLARA', text: "I'll send the agreement." }],
    actions: [action],
    execution_integrity: {
      a1: {
        canonical_execution: CANONICAL,
        execution_sha256: HASH,
      },
    },
    warnings: [],
    total: 1,
    ...overrides,
  };
}

test('adapts the engine response and copies Python integrity bytes unchanged', () => {
  const adapted = adaptEngineResponse(engineResult());

  assert.deepEqual(adapted.transcript, [{ id: 'L01', speaker: 'CLARA', text: "I'll send the agreement." }]);
  assert.equal(adapted.actions[0].canonical, CANONICAL);
  assert.equal(adapted.actions[0].hash, HASH);
  assert.equal(adapted.actions[0].canonical.includes('\\u20ac329,000'), true);
  assert.equal(adapted.actions[0].canonical.includes('"payload": {'), true);
  assert.deepEqual(adapted.actions[0].payload, engineResult().actions[0].payload);
});

test('fails closed for missing, extra, or malformed integrity data', () => {
  assert.throws(
    () => adaptEngineResponse(engineResult({ execution_integrity: {} })),
    /has no integrity entry/,
  );
  assert.throws(
    () => adaptEngineResponse(engineResult({ execution_integrity: {
      a1: { canonical_execution: CANONICAL, execution_sha256: HASH },
      a2: { canonical_execution: CANONICAL, execution_sha256: HASH },
    } })),
    /has no action/,
  );
  assert.throws(
    () => adaptEngineResponse(engineResult({ execution_integrity: {
      a1: { canonical_execution: CANONICAL, execution_sha256: 'not-a-sha256' },
    } })),
    /invalid execution_sha256/,
  );
  assert.throws(
    () => adaptEngineResponse(engineResult({ actions: [
      engineResult().actions[0],
      { ...engineResult().actions[0] },
    ], total: 2 })),
    /duplicate action id/,
  );
});

test('sends ENGINE_TOKEN only as the server-side Authorization bearer header and never logs it', async () => {
  const token = 'TEST_ENGINE_TOKEN_DO_NOT_LOG';
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => engineResult() };
  };
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const result = await extract(
      'https://engine.example.test/extract',
      token,
      'CLARA: I will send it.',
      'CLARA',
      new AbortController().signal,
    );
    assert.equal(result.actions[0].canonical, CANONICAL);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(request.init.headers.Authorization, 'Bearer ' + token);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(request.init.body).principal, 'CLARA');
  assert.equal(logs.some(line => line.includes(token)), false);
});
