import { Module } from '@nestjs/common';
import { SignupController } from './signup.controller';

/**
 * Public tenant signup. No service layer: the handler validates through its DTO
 * and writes one row, and a service wrapping a single create would be a file
 * that exists to look symmetrical.
 */
@Module({ controllers: [SignupController] })
export class SignupModule {}
