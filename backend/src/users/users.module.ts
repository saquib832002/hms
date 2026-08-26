import { Module } from '@nestjs/common';
import { MePasswordController, UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, MePasswordController],
  providers: [UsersService],
})
export class UsersModule {}
