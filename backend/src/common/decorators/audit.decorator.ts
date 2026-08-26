import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'auditAction';

/**
 * Gives a route a human-readable action name in the audit log.
 * Without it the interceptor falls back to "METHOD /route/path", which is
 * accurate but harder to read when someone is actually investigating.
 */
export const AuditAction = (action: string) => SetMetadata(AUDIT_ACTION_KEY, action);
