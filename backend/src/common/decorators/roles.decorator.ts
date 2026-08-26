import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Layer 1 of access control: may this role call this endpoint at all?
 *
 * This is NOT sufficient on its own. It cannot answer "may this user see this
 * particular row" — that requires a query, and belongs in the service. See
 * docs/technical-design.md §4.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
