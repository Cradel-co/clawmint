'use strict';

const correlationIdMiddleware = require('../middleware/correlationId');

function mockReq(headers = {}) {
  return { headers };
}
function mockRes() {
  return {
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
  };
}

describe('correlationIdMiddleware', () => {
  test('genera id cuando no viene en headers', () => {
    const req = mockReq();
    const res = mockRes();
    correlationIdMiddleware(req, res, () => {});
    expect(req.correlationId).toMatch(/^req-[a-f0-9]{8}$/);
    expect(res._headers['X-Correlation-Id']).toBe(req.correlationId);
  });

  test('respeta X-Correlation-Id del cliente', () => {
    const req = mockReq({ 'x-correlation-id': 'client-abc123' });
    const res = mockRes();
    correlationIdMiddleware(req, res, () => {});
    expect(req.correlationId).toBe('client-abc123');
  });

  test('respeta X-Request-Id como fallback', () => {
    const req = mockReq({ 'x-request-id': 'traceparent-xyz' });
    const res = mockRes();
    correlationIdMiddleware(req, res, () => {});
    expect(req.correlationId).toBe('traceparent-xyz');
  });

  test('sanitiza IDs con caracteres inválidos → genera nuevo', () => {
    const req = mockReq({ 'x-correlation-id': 'evil<script>id' });
    const res = mockRes();
    correlationIdMiddleware(req, res, () => {});
    expect(req.correlationId).toMatch(/^req-[a-f0-9]{8}$/);
    expect(req.correlationId).not.toContain('<');
  });

  test('trunca IDs > 128 chars', () => {
    const long = 'a'.repeat(200);
    const req = mockReq({ 'x-correlation-id': long });
    const res = mockRes();
    correlationIdMiddleware(req, res, () => {});
    expect(req.correlationId.length).toBeLessThanOrEqual(128);
  });

  test('invoca next()', () => {
    let called = false;
    correlationIdMiddleware(mockReq(), mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  test('IDs únicos entre requests', () => {
    const r1 = mockReq(); const r2 = mockReq();
    correlationIdMiddleware(r1, mockRes(), () => {});
    correlationIdMiddleware(r2, mockRes(), () => {});
    expect(r1.correlationId).not.toBe(r2.correlationId);
  });
});
