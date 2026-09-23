import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserRole } from '@prisma/client';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

import { AuthController } from '../../auth/auth.controller';
import { PatientsController } from '../../patients/patients.controller';
import { DoctorsController } from '../../doctors/doctors.controller';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { MedicalRecordsController } from '../../medical-records/medical-records.controller';
import { PrescriptionsController } from '../../prescriptions/prescriptions.controller';
import { PatientPrescriptionsController } from '../../prescriptions/patient-prescriptions.controller';
import { MeController } from '../../me/me.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
import { WardsController } from '../../wards/wards.controller';
import { AdmissionsController } from '../../admissions/admissions.controller';
import { PatientAdmissionsController } from '../../admissions/patient-admissions.controller';
import { VitalsController, PatientVitalsController } from '../../vitals/vitals.controller';
import {
  MedicationsController,
  MedicationScheduleController,
  MedicationChartController,
} from '../../medications/medications.controller';
import { MedicinesController } from '../../medicines/medicines.controller';
import { TaxRatesController } from '../../billing/tax-rates.controller';
import { PharmacyTillController } from '../../pharmacy/pharmacy-till.controller';
import { PharmacyPartnersController } from '../../pharmacy/partners.controller';
import { SignupController } from '../../signup/signup.controller';
import { DocumentsController } from '../../documents/documents.controller';
import { LetterheadController } from '../../documents/letterhead.controller';
import {
  ObservationsController,
  EscalationsController,
} from '../../observations/observations.controller';
import {
  SupplyRequestsController,
  MedicationRequestsController,
  WardRequestsController,
} from '../../ward-requests/ward-requests.controller';
import { PharmacyController } from '../../pharmacy/pharmacy.controller';
import {
  LabOrdersController,
  LabPartnersController,
  LabTestsController,
  LabWorklistController,
} from '../../lab/lab.controller';
import { LabTillController } from '../../lab/lab-till.controller';
import { LabAttachmentsController } from '../../lab/lab-attachments.controller';
import { PatientLabOrdersController } from '../../lab/patient-lab-orders.controller';
import { BillingController } from '../../billing/billing.controller';
import { UsersController, MePasswordController } from '../../users/users.controller';
import { DepartmentsController } from '../../departments/departments.controller';
import { AdminController } from '../../admin/admin.controller';
import { AuditController } from '../../audit/audit.controller';
import { HealthController } from '../../health/health.controller';
import {
  PlatformAuthController,
  PlatformController,
} from '../../platform/platform.controller';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { PlatformGuard } from '../../platform/platform-auth';

/**
 * The role × endpoint matrix, asserted statically off the decorators.
 *
 * This is the tedious test that actually protects patient data. It needs no
 * database, so there is no excuse not to run it, and it fails the moment
 * someone adds an endpoint without deciding who may call it — which is the
 * realistic way a clinical endpoint ends up accidentally reachable by
 * reception.
 */

const CONTROLLERS = [
  AuthController,
  PatientsController,
  DoctorsController,
  AppointmentsController,
  MedicalRecordsController,
  PrescriptionsController,
  PatientPrescriptionsController,
  MeController,
  NotificationsController,
  WardsController,
  AdmissionsController,
  PatientAdmissionsController,
  VitalsController,
  PatientVitalsController,
  MedicationsController,
  MedicationScheduleController,
  MedicationChartController,
  SupplyRequestsController,
  MedicationRequestsController,
  WardRequestsController,
  ObservationsController,
  EscalationsController,
  DocumentsController,
  LetterheadController,
  TaxRatesController,
  PharmacyTillController,
  PharmacyPartnersController,
  SignupController,
  MedicinesController,
  PharmacyController,
  LabTestsController,
  LabOrdersController,
  LabWorklistController,
  LabTillController,
  LabPartnersController,
  LabAttachmentsController,
  PatientLabOrdersController,
  BillingController,
  UsersController,
  MePasswordController,
  DepartmentsController,
  AdminController,
  AuditController,
  HealthController,
  PlatformAuthController,
  PlatformController,
];

interface Route {
  controller: string;
  handler: string;
  method: string;
  path: string;
  roles: UserRole[] | undefined;
  isPublic: boolean;
  isPlatform: boolean;
}

function routesOf(controller: new (...args: never[]) => object): Route[] {
  const proto = controller.prototype as Record<string, unknown>;
  const classRoles = Reflect.getMetadata(ROLES_KEY, controller) as UserRole[] | undefined;
  const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
  // Platform routes mark the whole controller, never a single handler.
  const isPlatform = Reflect.getMetadata(IS_PLATFORM_ROUTE_KEY, controller) === true;

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .filter((name) => Reflect.hasMetadata(METHOD_METADATA, proto[name] as object))
    .map((name) => {
      const fn = proto[name] as object;
      const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
      return {
        controller: controller.name,
        handler: name,
        method: RequestMethod[verb],
        path: `/${basePath}/${(Reflect.getMetadata(PATH_METADATA, fn) as string) ?? ''}`.replace(/\/+/g, '/'),
        roles: (Reflect.getMetadata(ROLES_KEY, fn) as UserRole[] | undefined) ?? classRoles,
        isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true,
        isPlatform,
      };
    });
}

const ROUTES: Route[] = CONTROLLERS.flatMap(routesOf);

/** Endpoints that expose diagnoses, prescriptions, allergies or the clinical queue. */
const CLINICAL = (r: Route) =>
  r.controller === 'MedicalRecordsController' ||
  r.controller === 'PatientPrescriptionsController' ||
  r.controller === 'MeController' ||
  r.controller === 'VitalsController' ||
  r.controller === 'PatientVitalsController' ||
  r.controller === 'MedicationsController' ||
  r.controller === 'MedicationScheduleController' ||
  // The drug chart names the patient, what they are on, and what they have
  // had. Clinical by any reading — the same line the ward board draws, and
  // admin is excluded from it for the same reason.
  r.controller === 'MedicationChartController' ||
  // Both request queues name a patient, a bed and a medicine, and a medication
  // request carries a nurse's clinical reasoning in free text. Clinical by the
  // same reading that keeps admin off the ward board.
  r.controller === 'SupplyRequestsController' ||
  r.controller === 'MedicationRequestsController' ||
  r.controller === 'WardRequestsController' ||
  // The observation plan and the escalation trail. Both name a patient, and an
  // escalation carries a written clinical concern about their condition.
  r.controller === 'ObservationsController' ||
  r.controller === 'EscalationsController' ||
  /*
   * Diagnostics.
   *
   * A lab order names a patient, carries the clinical question the doctor
   * typed, and holds their results. Clinical by the same reading that keeps
   * admin off the ward board and the drug round — and note which lab
   * controllers are NOT here: the catalogue is a price list, the partner
   * directory is a list of companies, and the till is money. An administrator
   * may read all three and no patient is reachable through any of them.
   */
  r.controller === 'LabOrdersController' ||
  r.controller === 'PatientLabOrdersController' ||
  r.controller === 'LabWorklistController' ||
  /*
   * An attachment is a result in a different container. The file a technician
   * uploads is an analyser printout, an imaging report or a working note — the
   * same content the values carry, and sometimes more of it, since nothing
   * shapes a PDF by role on the way out. Classifying it as anything but
   * clinical would let an administrator read a report they cannot read as data.
   */
  r.controller === 'LabAttachmentsController' ||
  /*
   * Printing.
   *
   * `record` is clinical: a consultation note carries a diagnosis. `prescription`
   * deliberately is not, and that is the same carve-out the old
   * `PrescriptionsController.print` had — reception hands the paper to the
   * patient at the front desk and must never read the prescription as data.
   * The two halves of that rule are asserted directly below, because a
   * classifier exception is exactly the sort of thing that quietly widens.
   *
   * `invoice` is money, not clinical, and is role-shaped inside the renderer:
   * a billing clerk's copy collapses the medicine lines exactly as their API
   * response does.
   */
  (r.controller === 'DocumentsController' && r.handler === 'record') ||
  r.controller === 'AdmissionsController' ||
  r.controller === 'PatientAdmissionsController' ||
  // The ward board shows patients in beds; the bare ward list does not.
  (r.controller === 'WardsController' && r.handler === 'board') ||
  // The dispensing queue, prescription detail and history all name patients and
  // their medicines. Stock and deliveries carry no patient at all, and the
  // medicine catalogue is not PHI — so neither is clinical.
  /*
   * The dispensing queue, prescription detail and history all name patients and
   * their medicines. Stock, deliveries and the pharmacy's own daily figures
   * carry no patient at all — the dashboard is counts and money, which is why
   * an owner reconciling the shop may read it.
   */
  (r.controller === 'PharmacyController' &&
    !['inventory', 'receive', 'dashboard'].includes(r.handler)) ||
  (r.controller === 'PrescriptionsController' && r.handler !== 'print');

describe('access matrix', () => {
  it('discovers every controller', () => {
    expect(ROUTES.length).toBeGreaterThan(15);
  });

  it('covers every controller registered in AppModule', () => {
    // This suite only sees controllers listed in CONTROLLERS above, so adding
    // a module without adding it here would silently exempt it from every
    // assertion below. Comparing against the filesystem closes that hole —
    // it is exactly how NotificationsController slipped through once.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const srcRoot = path.resolve(__dirname, '../..');

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.controller.ts')) {
          const match = /export class (\w+Controller)/.exec(fs.readFileSync(full, 'utf8'));
          if (match) found.push(match[1]);
        }
      }
    };
    walk(srcRoot);

    const covered = CONTROLLERS.map((c) => c.name);
    expect(found.filter((name) => !covered.includes(name))).toEqual([]);
  });

  describe('administration', () => {
    it('confines user management and reporting to admin', () => {
      const adminOnly = ROUTES.filter(
        (r) => r.controller === 'UsersController' || r.controller === 'AdminController',
      );
      expect(adminOnly.length).toBeGreaterThan(5);
      for (const r of adminOnly) expect(r.roles).toEqual([UserRole.ADMIN]);
    });

    it('gives admin no clinical READ endpoint at all', () => {
      // The rule from CLAUDE.md: admin is operational, not clinical. It has
      // held since Phase 1, and gaining a dashboard in Phase 6 must not have
      // quietly opened a door — a management screen is the obvious back way in.
      //
      // This assertion found a genuine violation when it was written: the ward
      // board had been open to admin since Phase 3, and it lists who is in
      // which bed with an allergy flag.
      const clinicalReads = ROUTES.filter(
        (r) => CLINICAL(r) && r.method === 'GET' && r.roles?.includes(UserRole.ADMIN),
      ).map((r) => `${r.controller}.${r.handler}`);

      expect(clinicalReads).toEqual([]);
    });

    /*
     * THE RULE CHANGED, AND IT CHANGED IN THE OPEN
     * --------------------------------------------
     * "Admin sees no patient identity anywhere" held for six phases and is no
     * longer true: `GET /admin/reports/consultations` returns the patients
     * behind a count on the owner's daily activity screen — who attended, when,
     * what they were charged, whether they paid.
     *
     * That was asked for and is defensible. An owner reconciling their own
     * clinic needs to know a doctor's three consultations were three real
     * people who were billed; every field crossing over is one reception sees
     * at the desk and billing sees on an invoice.
     *
     * The dishonest version of this change was available and tempting: put the
     * route on `AdminController`, watch the test above stay green because it
     * keys on *clinical controllers*, and leave a rule in the file saying
     * something that had stopped being true. A safety net you have quietly
     * stepped around is worse than none — the next person reads it and believes
     * it.
     *
     * So the rule is restated as what it now is: **attendance and money, never
     * clinical content**, asserted directly against the one endpoint that
     * carries identity.
     */
    it('lets admin see attendance and money, and nothing clinical', () => {
      const SERVICE = readFileSync(
        resolve(__dirname, '../../admin/admin.service.ts'),
        'utf8',
      )
        // Comments explain the boundary using the same words the boundary
        // forbids. Asserting against them would fail the build for documenting
        // itself, and the tempting fix is to weaken the documentation.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      const start = SERVICE.indexOf('async consultationLedger(');
      expect(start).toBeGreaterThan(-1);
      const body = SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10));

      // Identity and money: the point of the endpoint.
      expect(body).toContain('patient: { select: { id: true, fullName: true } }');
      expect(body).toContain('invoice: { select: { id: true, totalAmount: true, amountPaid: true } }');

      /*
       * `reason` is the dangerous one and the reason this is a source test.
       * Reception types it at booking and it is routinely "chest pain" — a
       * clinical fact sitting one field away from everything above, on the same
       * model, which any `include` or careless `select` would carry across.
       */
      expect(body).not.toMatch(/\breason\b/);

      // Whether a prescription exists is operational; what is in it names a
      // condition. Only the id is fetched, so no shape can render contents.
      expect(body).toContain('prescription: { select: { id: true } }');
      expect(body).not.toMatch(/items|medicineName|dosage/);

      for (const clinical of ['diagnosis', 'allergie', 'medicalRecord', 'vital', 'admission']) {
        expect(body.toLowerCase()).not.toContain(clinical);
      }

      // Never the whole row. `patient: true` would carry dob, phone, address
      // and the insurer into a management screen as valid, unremarkable data.
      expect(body).not.toMatch(/patient:\s*true/);
      expect(body).not.toMatch(/include:/);
    });

    it('audits the one admin route that reads patient identity under its own name', () => {
      // "Who looked up our patient list, and when" must be answerable without
      // unpicking a generic report action.
      const controller = readFileSync(
        resolve(__dirname, '../../admin/admin.controller.ts'),
        'utf8',
      );
      expect(controller).toContain("@AuditAction('ADMIN_CONSULTATION_LEDGER')");
    });

    it('keeps admin out of records, observations and the drug chart entirely', () => {
      const off = ROUTES.filter((r) =>
        ['MedicalRecordsController', 'VitalsController', 'PatientVitalsController',
         'MedicationsController', 'PatientPrescriptionsController'].includes(r.controller),
      );
      expect(off.length).toBeGreaterThan(4);
      for (const r of off) expect(r.roles).not.toContain(UserRole.ADMIN);
    });

    it('still lets admin manage beds, because that is how a mistake gets fixed', () => {
      // Writes, not reads. An admin locked out of bed management has no route
      // but a database console, and every one of these is audited.
      const admit = ROUTES.find((r) => r.controller === 'AdmissionsController' && r.handler === 'admit');
      const discharge = ROUTES.find(
        (r) => r.controller === 'AdmissionsController' && r.handler === 'discharge',
      );
      expect(admit?.roles).toContain(UserRole.ADMIN);
      expect(discharge?.roles).toContain(UserRole.ADMIN);
    });

    it('lets admin see stock but not the dispensing queue', () => {
      // Inventory is operational; the queue names patients and their medicines.
      const inventory = ROUTES.find((r) => r.controller === 'PharmacyController' && r.handler === 'inventory');
      const queue = ROUTES.find((r) => r.controller === 'PharmacyController' && r.handler === 'queue');
      expect(inventory?.roles).toContain(UserRole.ADMIN);
      expect(queue?.roles).not.toContain(UserRole.ADMIN);
    });

    it('lets any authenticated user change their own password', () => {
      // A forced change must not require the role the account is locked out of.
      const change = ROUTES.find((r) => r.controller === 'MePasswordController');
      expect(change?.roles).toBeUndefined();
      expect(change?.isPublic).toBe(false);
    });

    it('lets every role read departments but only admin edit them', () => {
      const read = ROUTES.find((r) => r.controller === 'DepartmentsController' && r.handler === 'findAll');
      const write = ROUTES.find((r) => r.controller === 'DepartmentsController' && r.handler === 'create');
      expect(read?.roles?.length).toBeGreaterThan(3);
      expect(write?.roles).toEqual([UserRole.ADMIN]);
    });
  });

  it('has no route that is neither @Public nor role-restricted', () => {
    // A route with no @Roles() is reachable by ANY authenticated user. That is
    // occasionally correct, but it must be a decision rather than an omission —
    // so intentional cases are listed here and everything else fails.
    //
    // GET /auth/me returns only the caller's own identity, and both clients
    // need it on boot to build their navigation. Restricting it by role would
    // be circular: you cannot know the role until you have called it.
    const INTENTIONALLY_ANY_AUTHENTICATED = [
      'AuthController.me',
      // Changing your own password cannot be role-gated: a user forced to
      // change it is otherwise blocked from every screen, including this one.
      'MePasswordController.changePassword',
      // Switching to one of your OWN roles cannot be role-gated either — the
      // whole point is that the caller's current role is about to change, so
      // gating on it would mean an owner-doctor could enter admin but never
      // leave. The authorisation is the assignment check inside the handler:
      // it refuses any role the user does not hold, so this grants nothing.
      'AuthController.switchRole',
    ];

    // Platform routes carry no @Roles by design — they are not reachable by an
    // authenticated hospital user at all, so "any authenticated user" does not
    // describe them. Their own assertions are below.
    const undecided = ROUTES.filter((r) => !r.isPublic && !r.roles && !r.isPlatform)
      .map((r) => `${r.controller}.${r.handler}`)
      .filter((name) => !INTENTIONALLY_ANY_AUTHENTICATED.includes(name));

    expect(undecided).toEqual([]);
  });

  describe('the vendor platform API', () => {
    const platform = ROUTES.filter((r) => r.isPlatform);

    it('is found at all', () => {
      // Guards the four assertions below against passing vacuously if the
      // decorator is ever renamed and the metadata key silently stops matching.
      expect(platform.length).toBeGreaterThan(4);
    });

    it('lives entirely under /platform', () => {
      // The prefix is what an operator would firewall on. A platform route
      // mounted elsewhere would be exposed on the hospital-facing surface with
      // nothing in its path to say so.
      for (const r of platform) expect(r.path.startsWith('/platform/')).toBe(true);
      expect(ROUTES.filter((r) => r.path.startsWith('/platform')).length).toBe(platform.length);
    });

    it('is never marked @Public', () => {
      // The distinction the separate decorator exists to preserve. @Public
      // means unauthenticated; these need a credential no hospital holds.
      for (const r of platform) expect(r.isPublic).toBe(false);
    });

    it('carries no UserRole, so RolesGuard can never admit it', () => {
      /*
       * The load-bearing one.
       *
       * A platform principal has no `UserRole` and PlatformGuard never sets
       * req.user. Adding @Roles() here would be the first step toward a vendor
       * token satisfying a clinical rule — so the absence is asserted rather
       * than assumed, and this fails the day someone reaches for it.
       */
      for (const r of platform) expect(r.roles).toBeUndefined();
    });

    it('guards everything except the login that issues the credential', () => {
      const guarded = (c: new (...args: never[]) => object) =>
        ((Reflect.getMetadata('__guards__', c) as unknown[]) ?? []).includes(PlatformGuard);

      expect(guarded(PlatformController)).toBe(true);
      // Login cannot be guarded by the thing it produces. It is alone in its
      // own controller precisely so this exception stays a single visible line.
      expect(guarded(PlatformAuthController)).toBe(false);
      expect(routesOf(PlatformAuthController).map((r) => r.handler)).toEqual(['login']);
    });
  });

  describe('device registration', () => {
    it('is limited to the roles that have a mobile app', () => {
      const routes = ROUTES.filter((r) => r.controller === 'NotificationsController');
      expect(routes.length).toBe(2);
      for (const r of routes) {
        expect(r.roles).toEqual([UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST]);
      }
    });

    it('is not open to reception, billing or admin', () => {
      for (const r of ROUTES.filter((x) => x.controller === 'NotificationsController')) {
        expect(r.roles).not.toContain(UserRole.RECEPTIONIST);
        expect(r.roles).not.toContain(UserRole.BILLING_STAFF);
        expect(r.roles).not.toContain(UserRole.ADMIN);
      }
    });
  });

  it('exposes only login, refresh, logout, health and public signup', () => {
    /*
     * The exact set, not a count — the value of this assertion is that adding a
     * fifth `@Public()` route has to be argued for here, in a diff somebody
     * reads.
     *
     * `SignupController.apply` is that fifth, and CLAUDE.md has described it as
     * such since it was written: the first public route that *writes*. It was
     * missing from this list because `SignupController` was never in
     * `CONTROLLERS` — the suite could not run at all until the native argon2
     * binding was rebuilt, so nothing ever reported the omission. Three other
     * controllers were unchecked the same way; a test nobody can run asserts
     * nothing.
     */
    const publicRoutes = ROUTES.filter((r) => r.isPublic).map((r) => `${r.controller}.${r.handler}`);
    expect(publicRoutes.sort()).toEqual([
      'AuthController.login',
      'AuthController.logout',
      'AuthController.refresh',
      'HealthController.check',
      'SignupController.signup',
    ]);
  });

  describe('RECEPTIONIST', () => {
    it('cannot reach any clinical endpoint', () => {
      const leaks = ROUTES.filter(
        (r) => CLINICAL(r) && r.roles?.includes(UserRole.RECEPTIONIST),
      ).map((r) => `${r.controller}.${r.handler}`);
      expect(leaks).toEqual([]);
    });

    it('can still register patients and manage appointments', () => {
      const create = ROUTES.find((r) => r.controller === 'PatientsController' && r.handler === 'create');
      const book = ROUTES.find((r) => r.controller === 'AppointmentsController' && r.handler === 'create');
      expect(create?.roles).toContain(UserRole.RECEPTIONIST);
      expect(book?.roles).toContain(UserRole.RECEPTIONIST);
    });

    it('may print a prescription without being able to read it as data', () => {
      // Moved to DocumentsController when printing became a real PDF drawn on
      // the hospital's own letterhead. The rule is unchanged.
      const print = ROUTES.find(
        (r) => r.controller === 'DocumentsController' && r.handler === 'prescription',
      );
      const read = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'findOne');
      expect(print?.roles).toContain(UserRole.RECEPTIONIST);
      expect(read?.roles).not.toContain(UserRole.RECEPTIONIST);
    });
  });

  describe('billing', () => {
    it('is reachable only by billing and admin', () => {
      // The cleanest role boundary in the system, in both directions: no
      // clinician can void an invoice, and billing goes nowhere near a
      // diagnosis.
      const billing = ROUTES.filter((r) => r.controller === 'BillingController');
      expect(billing.length).toBeGreaterThan(5);
      for (const r of billing) {
        expect(r.roles?.sort()).toEqual([UserRole.ADMIN, UserRole.BILLING_STAFF].sort());
      }
    });

    it('gives no clinical role any billing access', () => {
      for (const r of ROUTES.filter((x) => x.controller === 'BillingController')) {
        expect(r.roles).not.toContain(UserRole.DOCTOR);
        expect(r.roles).not.toContain(UserRole.NURSE);
        expect(r.roles).not.toContain(UserRole.PHARMACIST);
        expect(r.roles).not.toContain(UserRole.RECEPTIONIST);
      }
    });
  });

  describe('BILLING_STAFF', () => {
    it('cannot reach any clinical endpoint', () => {
      const leaks = ROUTES.filter(
        (r) => CLINICAL(r) && r.roles?.includes(UserRole.BILLING_STAFF),
      ).map((r) => `${r.controller}.${r.handler}`);
      expect(leaks).toEqual([]);
    });

    it('can run invoices and payments', () => {
      const invoices = ROUTES.find((r) => r.controller === 'BillingController' && r.handler === 'findAll');
      const pay = ROUTES.find((r) => r.controller === 'BillingController' && r.handler === 'recordPayment');
      expect(invoices?.roles).toContain(UserRole.BILLING_STAFF);
      expect(pay?.roles).toContain(UserRole.BILLING_STAFF);
    });

    it('cannot touch appointments at all', () => {
      const appointmentRoutes = ROUTES.filter((r) => r.controller === 'AppointmentsController');
      for (const r of appointmentRoutes) {
        expect(r.roles).not.toContain(UserRole.BILLING_STAFF);
      }
    });
  });

  describe('ADMIN', () => {
    it('is the only role that can read the audit log', () => {
      const audit = ROUTES.filter((r) => r.controller === 'AuditController');
      expect(audit.length).toBeGreaterThan(0);
      for (const r of audit) expect(r.roles).toEqual([UserRole.ADMIN]);
    });

    it('is not granted clinical write access', () => {
      // Admin is operational, not clinical. Writing a diagnosis or issuing a
      // prescription is not an administrative act.
      const write = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'create');
      const rx = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'create');
      expect(write?.roles).not.toContain(UserRole.ADMIN);
      expect(rx?.roles).not.toContain(UserRole.ADMIN);
    });

    it('cannot read medical records', () => {
      const read = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'findForPatient');
      expect(read?.roles).not.toContain(UserRole.ADMIN);
    });
  });

  describe('DOCTOR', () => {
    it('is the only role that can write records and prescriptions', () => {
      const record = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'create');
      const rx = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'create');
      expect(record?.roles).toEqual([UserRole.DOCTOR]);
      expect(rx?.roles).toEqual([UserRole.DOCTOR]);
    });

    it('cannot register or edit patients', () => {
      const create = ROUTES.find((r) => r.controller === 'PatientsController' && r.handler === 'create');
      const update = ROUTES.find((r) => r.controller === 'PatientsController' && r.handler === 'update');
      expect(create?.roles).not.toContain(UserRole.DOCTOR);
      expect(update?.roles).not.toContain(UserRole.DOCTOR);
    });

    it('owns the queue endpoint exclusively', () => {
      const queue = ROUTES.find((r) => r.controller === 'MeController');
      expect(queue?.roles).toEqual([UserRole.DOCTOR]);
    });
  });

  describe('inpatient care', () => {
    it('lets only nurses sign for a medicine', () => {
      // A doctor prescribes; the nurse gives it and signs for it. Conflating
      // the two loses who was actually at the bedside.
      const record = ROUTES.find(
        (r) => r.controller === 'MedicationsController' && r.handler === 'record',
      );
      expect(record?.roles).toEqual([UserRole.NURSE]);
    });

    it('lets nurses and doctors record observations, and nobody else', () => {
      const create = ROUTES.find((r) => r.controller === 'VitalsController' && r.handler === 'create');
      expect(create?.roles?.sort()).toEqual([UserRole.DOCTOR, UserRole.NURSE].sort());
    });

    it('keeps reception and billing out of every inpatient endpoint', () => {
      const inpatient = ROUTES.filter(
        (r) =>
          ['AdmissionsController', 'PatientAdmissionsController', 'VitalsController',
           'PatientVitalsController', 'MedicationsController', 'MedicationScheduleController',
           'MedicationChartController', 'WardRequestsController',
           'ObservationsController', 'EscalationsController'].includes(
            r.controller,
          ),
      );
      expect(inpatient.length).toBeGreaterThan(5);
      for (const r of inpatient) {
        expect(r.roles).not.toContain(UserRole.RECEPTIONIST);
        expect(r.roles).not.toContain(UserRole.BILLING_STAFF);
        expect(r.roles).not.toContain(UserRole.PHARMACIST);
      }
    });

    it('lets reception see which wards exist but not who is in them', () => {
      const list = ROUTES.find((r) => r.controller === 'WardsController' && r.handler === 'findAll');
      const board = ROUTES.find((r) => r.controller === 'WardsController' && r.handler === 'board');
      expect(list?.roles).toContain(UserRole.RECEPTIONIST);
      expect(board?.roles).not.toContain(UserRole.RECEPTIONIST);
    });
  });

  describe('NURSE', () => {
    it('can read clinical records but not write them', () => {
      const read = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'findForPatient');
      const write = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'create');
      expect(read?.roles).toContain(UserRole.NURSE);
      expect(write?.roles).not.toContain(UserRole.NURSE);
    });

    it('can now run a ward — admit, observe, medicate', () => {
      const admit = ROUTES.find((r) => r.controller === 'AdmissionsController' && r.handler === 'admit');
      const vitals = ROUTES.find((r) => r.controller === 'VitalsController' && r.handler === 'create');
      const dose = ROUTES.find((r) => r.controller === 'MedicationsController' && r.handler === 'record');
      expect(admit?.roles).toContain(UserRole.NURSE);
      expect(vitals?.roles).toContain(UserRole.NURSE);
      expect(dose?.roles).toContain(UserRole.NURSE);
    });

    it('cannot book or modify appointments', () => {
      const book = ROUTES.find((r) => r.controller === 'AppointmentsController' && r.handler === 'create');
      const status = ROUTES.find((r) => r.controller === 'AppointmentsController' && r.handler === 'changeStatus');
      expect(book?.roles).not.toContain(UserRole.NURSE);
      expect(status?.roles).not.toContain(UserRole.NURSE);
    });
  });

  describe('pharmacy', () => {
    it('lets only a pharmacist sign for a dispense', () => {
      // Admin is deliberately excluded. Handing over medicine is a
      // professional act, not an administrative one — an operational role must
      // not be able to sign for it.
      const dispense = ROUTES.find(
        (r) => r.controller === 'PharmacyController' && r.handler === 'dispense',
      );
      expect(dispense?.roles).toEqual([UserRole.PHARMACIST]);
    });

    it('keeps reception, billing and nurses out of the dispensing surface', () => {
      const pharmacy = ROUTES.filter((r) => r.controller === 'PharmacyController');
      expect(pharmacy.length).toBeGreaterThan(4);
      for (const r of pharmacy) {
        expect(r.roles).not.toContain(UserRole.RECEPTIONIST);
        expect(r.roles).not.toContain(UserRole.BILLING_STAFF);
        expect(r.roles).not.toContain(UserRole.NURSE);
      }
    });

    it('lets clinical staff read the catalogue but not edit it', () => {
      // Doctors need it to prescribe and nurses to check a chart; changing a
      // drug class silently changes every future allergy check.
      const read = ROUTES.find((r) => r.controller === 'MedicinesController' && r.handler === 'findAll');
      const write = ROUTES.find((r) => r.controller === 'MedicinesController' && r.handler === 'create');
      expect(read?.roles).toContain(UserRole.DOCTOR);
      expect(read?.roles).toContain(UserRole.NURSE);
      expect(write?.roles).not.toContain(UserRole.DOCTOR);
      expect(write?.roles).not.toContain(UserRole.NURSE);
    });
  });

  describe('PHARMACIST', () => {
    it('can read prescriptions but not issue or cancel them', () => {
      const read = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'findOne');
      const create = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'create');
      const cancel = ROUTES.find((r) => r.controller === 'PrescriptionsController' && r.handler === 'cancel');
      expect(read?.roles).toContain(UserRole.PHARMACIST);
      expect(create?.roles).not.toContain(UserRole.PHARMACIST);
      expect(cancel?.roles).not.toContain(UserRole.PHARMACIST);
    });

    it('cannot read medical records', () => {
      const read = ROUTES.find((r) => r.controller === 'MedicalRecordsController' && r.handler === 'findForPatient');
      expect(read?.roles).not.toContain(UserRole.PHARMACIST);
    });
  });

  it('never grants a write endpoint to every role at once', () => {
    const writes = ROUTES.filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method) && !r.isPublic);
    for (const r of writes) {
      expect(r.roles?.length ?? 0).toBeLessThan(Object.values(UserRole).length);
    }
  });
});
