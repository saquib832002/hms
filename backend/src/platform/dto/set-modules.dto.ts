import { ArrayUnique, IsArray, IsEnum } from 'class-validator';
import { TenantModule } from '@prisma/client';

/**
 * The complete set, not a delta.
 *
 * "Add the laboratory" and "these are the five things they have" read the same
 * from a screen with checkboxes on it, and the second is the one that cannot
 * drift: two vendor staff editing the same tenant with deltas produces a state
 * neither of them chose, and nothing would say so.
 *
 * An empty array is legal and means a hospital with patients, staff and
 * settings and nothing else. Odd, and a real state during onboarding — refusing
 * it would be inventing a rule to avoid thinking about it.
 */
export class SetModulesDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(TenantModule, { each: true })
  modules!: TenantModule[];
}
