import { ArgumentsHost, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuditOutcome } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AuditService } from '../../audit/audit.service';

/**
 * Guards against the audit gap coming back.
 *
 * A live run against a real database found that denials were never recorded:
 * 30 SUCCESS rows and zero FAILURE rows, after deliberately triggering five
 * 403s, a 401 and three 429s. The cause was structural — `AuditInterceptor`
 * had an error handler that could never fire, because guards run before
 * interceptors and a rejected request never reaches one.
 *
 * That bug survived 348 unit tests and several readings of the code. It could
 * not be caught by testing the interceptor, because the interceptor's own
 * behaviour was correct in isolation; what was wrong was the assumption that it
 * would be invoked at all.
 *
 * These tests assert the property directly on the component that *does* run for
 * a guard rejection. If failure logging is ever moved back into the
 * interceptor, this suite fails.
 */

function mockResponse() {
  const res = {
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

function mockHost(req: Record<string, unknown>, res: unknown): ArgumentsHost {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    path: '/api/v1/patients/1/records',
    originalUrl: '/api/v1/patients/1/records',
    route: { path: '/api/v1/patients/:patientId/records' },
    params: { id: '1' },
    headers: { 'user-agent': 'jest' },
    clientIp: '10.0.0.9',
    requestId: 'req-1',
    body: {},
    ...overrides,
  };
}

describe('failure auditing', () => {
  let audit: { record: jest.Mock };
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    audit = { record: jest.fn() };
    filter = new AllExceptionsFilter(audit as unknown as AuditService);
    // The filter logs the error; silence it so the suite output stays readable.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('records a 403 from a role guard', () => {
    // The exact case the audit trail exists for: a receptionist reaching for
    // clinical data. Previously logged nowhere at all.
    const req = baseRequest({
      user: { userId: 7, email: 'reception@demo.test', role: 'RECEPTIONIST' },
    });
    filter.catch(new ForbiddenException('You do not have access'), mockHost(req, mockResponse()));

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0][0];
    expect(entry.outcome).toBe(AuditOutcome.FAILURE);
    expect(entry.statusCode).toBe(403);
    expect(entry.actorRole).toBe('RECEPTIONIST');
    expect(entry.userId).toBe(7);
  });

  it('records which record was reached for', () => {
    // "Who was refused access to which patient" is the question an
    // investigation asks; a bare 403 count cannot answer it.
    const req = baseRequest({ user: { userId: 7, email: 'a@b.test', role: 'RECEPTIONIST' } });
    filter.catch(new ForbiddenException(), mockHost(req, mockResponse()));

    const entry = audit.record.mock.calls[0][0];
    expect(entry.targetType).toBe('Patient');
    expect(entry.targetId).toBe(1);
  });

  it('records an unauthenticated 401 with no user', () => {
    const req = baseRequest({ user: undefined });
    filter.catch(new UnauthorizedException(), mockHost(req, mockResponse()));

    const entry = audit.record.mock.calls[0][0];
    expect(entry.outcome).toBe(AuditOutcome.FAILURE);
    expect(entry.userId).toBeNull();
    expect(entry.actorRole).toBeNull();
  });

  it('captures the attempted email on a failed login', () => {
    // No user to attribute, so the address tried is the only identifier — and
    // repeated failures against a real account are what this row is for.
    const req = baseRequest({
      method: 'POST',
      path: '/api/v1/auth/login',
      route: { path: '/api/v1/auth/login' },
      params: {},
      body: { email: 'nurse@demo.test', password: 'hunter2' },
      user: undefined,
    });
    filter.catch(new UnauthorizedException(), mockHost(req, mockResponse()));

    const entry = audit.record.mock.calls[0][0];
    expect(entry.actorEmail).toBe('nurse@demo.test');
  });

  it('never records the password', () => {
    const req = baseRequest({
      method: 'POST',
      path: '/api/v1/auth/login',
      route: { path: '/api/v1/auth/login' },
      params: {},
      body: { email: 'nurse@demo.test', password: 'SuperSecret123' },
    });
    filter.catch(new UnauthorizedException(), mockHost(req, mockResponse()));

    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain('SuperSecret123');
  });

  it('records a rate-limit rejection', () => {
    // 429s from the throttler are also guard rejections, and a burst of them
    // is exactly the signal worth keeping.
    const req = baseRequest({ user: undefined });
    const tooMany = new ForbiddenException();
    Object.defineProperty(tooMany, 'status', { value: 429 });
    jest.spyOn(tooMany, 'getStatus').mockReturnValue(429);

    filter.catch(tooMany, mockHost(req, mockResponse()));
    expect(audit.record.mock.calls[0][0].statusCode).toBe(429);
  });

  it('does not audit health checks', () => {
    // Probes fail noisily at startup and are not security events.
    const req = baseRequest({ path: '/api/v1/health', route: { path: '/api/v1/health' } });
    filter.catch(new Error('db down'), mockHost(req, mockResponse()));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('still returns problem+json and never a stack trace', () => {
    const res = mockResponse();
    const req = baseRequest();
    filter.catch(new Error('boom at /src/secret/path.ts:42'), mockHost(req, res));

    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe(500);
    expect(body.detail).toBe('The request could not be completed.');
    expect(JSON.stringify(body)).not.toContain('secret/path.ts');
  });
});

/**
 * The structural assertion: the interceptor must not carry an error handler.
 *
 * If someone reinstates `tap({ next, error })` there, failures either go
 * unlogged again (for guard rejections, which is the majority) or get logged
 * twice (for handler exceptions). Both are wrong, and neither shows up in a
 * normal test.
 */
describe('audit interceptor', () => {
  it('logs successes only, leaving failures to the filter', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../interceptors/audit.interceptor.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('AuditOutcome.FAILURE');
    expect(code).toContain('AuditOutcome.SUCCESS');
  });
});
