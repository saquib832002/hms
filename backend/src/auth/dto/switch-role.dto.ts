import { IsEnum } from 'class-validator';
import { UserRole } from '@prisma/client';

export class SwitchRoleDto {
  /**
   * The role to act as from now on.
   *
   * Accepted from the client because it is a *request*, not a grant: the server
   * checks it against the roles this user actually holds before issuing a token
   * for it. The same reasoning as the hospital slug on login — naming something
   * is not the same as being allowed it.
   */
  @IsEnum(UserRole, { message: 'role must be one of the known staff roles' })
  role: UserRole;
}
