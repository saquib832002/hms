import { SetMetadata } from '@nestjs/common';
import { TenantModule } from '@prisma/client';

export const REQUIRES_MODULE_KEY = 'requiresModule';

/**
 * Marks a controller as belonging to one part of the product.
 *
 * Applied at the class level, not per handler. A module is a whole area of the
 * application — every route on `LabWorklistController` belongs to the
 * laboratory — and per-handler marking would be six chances to forget on one
 * controller instead of one.
 *
 * `ModuleGuard` reads this and refuses writes for a tenant that has not been
 * sold it. Reads pass regardless; see `tenant-modules.ts` for why.
 */
export const RequiresModule = (module: TenantModule) => SetMetadata(REQUIRES_MODULE_KEY, module);
