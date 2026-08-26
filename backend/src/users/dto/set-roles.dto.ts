import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';
import { UserRole } from '@prisma/client';

export class SetRolesDto {
  /**
   * The complete set of roles this person may act as — not a delta.
   *
   * Sending the whole set makes removal expressible at all, and makes two
   * admins editing at once resolve to one of the two intended states rather
   * than a merge of both.
   */
  @IsArray()
  @ArrayMinSize(1, { message: 'A user must keep at least one role' })
  @IsEnum(UserRole, { each: true })
  roles: UserRole[];
}
