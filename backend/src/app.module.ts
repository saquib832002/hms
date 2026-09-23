import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';

import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './common/tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { PatientsModule } from './patients/patients.module';
import { DoctorsModule } from './doctors/doctors.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { MedicalRecordsModule } from './medical-records/medical-records.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { MeModule } from './me/me.module';
import { WardsModule } from './wards/wards.module';
import { AdmissionsModule } from './admissions/admissions.module';
import { VitalsModule } from './vitals/vitals.module';
import { MedicationsModule } from './medications/medications.module';
import { WardRequestsModule } from './ward-requests/ward-requests.module';
import { ObservationsModule } from './observations/observations.module';
import { LabModule } from './lab/lab.module';
import { DocumentsModule } from './documents/documents.module';
import { MedicinesModule } from './medicines/medicines.module';
import { PharmacyModule } from './pharmacy/pharmacy.module';
import { BillingModule } from './billing/billing.module';
import { UsersModule } from './users/users.module';
import { DepartmentsModule } from './departments/departments.module';
import { AdminModule } from './admin/admin.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlatformModule } from './platform/platform.module';
import { SignupModule } from './signup/signup.module';
import { HealthModule } from './health/health.module';

import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { SubscriptionGuard } from './common/guards/subscription.guard';
import { ModuleGuard } from './common/guards/module.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    TenancyModule,
    AuditModule,
    AuthModule,
    PatientsModule,
    DoctorsModule,
    AppointmentsModule,
    MedicalRecordsModule,
    PrescriptionsModule,
    MeModule,
    WardsModule,
    AdmissionsModule,
    VitalsModule,
    MedicationsModule,
    WardRequestsModule,
    ObservationsModule,
    LabModule,
    DocumentsModule,
    MedicinesModule,
    PharmacyModule,
    BillingModule,
    UsersModule,
    DepartmentsModule,
    AdminModule,
    NotificationsModule,
    PlatformModule,
    SignupModule,
    HealthModule,
  ],
  providers: [
    // ORDER MATTERS. Guards run top to bottom:
    //   1. Throttler  — cheapest rejection first; no point authenticating a
    //                   request that is over its rate limit.
    //   2. JwtAuthGuard — establishes req.user.
    //   3. RolesGuard   — needs req.user, so it must come after.
    // Buckets by IP, except on login where it buckets by IP + account — see
    // AppThrottlerGuard. A route-level guard cannot fix this, because the
    // global one still runs and would remain the binding limit.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    /*
     * Last of the guards, and that ordering is deliberate: a request that is
     * about to be refused for the wrong role should say so, rather than being
     * told the subscription lapsed. Refusals are more useful when they name the
     * first thing that was wrong.
     */
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    /*
     * After the subscription guard, and the order does not matter — both refuse
     * writes and neither refuses a read, so whichever runs first produces the
     * more useful message. A hospital that has both lapsed and never bought the
     * lab is told about the subscription, which is the one they can fix.
     */
    { provide: APP_GUARD, useClass: ModuleGuard },

    // Opens the tenant transaction. Must be listed BEFORE AuditInterceptor:
    // global interceptors run in registration order, and the audit write has to
    // land inside the tenant transaction to be stamped with the right hospital.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },

    // Runs after the guards, so it can see both who the caller was and
    // whether they were allowed through. Middleware could see neither.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
