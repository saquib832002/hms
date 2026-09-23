import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { SignupDto } from './dto/signup.dto';

/**
 * A hospital asking to become a customer.
 *
 * THE FIFTH PUBLIC ROUTE, AND THE FIRST THAT WRITES
 * -------------------------------------------------
 * Until now `@Public()` meant login, refresh, logout and health — three reads
 * and one thing you cannot do without credentials anyway. This is the first
 * unauthenticated endpoint that creates a row, which is a different kind of
 * thing and gets treated as one:
 *
 *  - Its own throttle bucket, tighter than login's.
 *  - It writes to `tenant_applications` and nothing else. No `Tenant`, no
 *    `User`, no slug taken. Every consequential decision happens at approval,
 *    under a platform login, after a human has read it.
 *  - It cannot be used to learn anything. See below.
 *
 * WHY IT DOES NOT SAY "YOU HAVE ALREADY APPLIED"
 * ----------------------------------------------
 * The friendly version of this endpoint tells a repeat applicant that their
 * email is already on file. That turns the form into a membership oracle:
 * anybody could test addresses, or hospital names, and learn who the vendor's
 * customers and prospects are. So the response is identical either way, and the
 * duplicate is recorded for the reviewer to notice instead.
 *
 * Same reasoning as the login form, which does not distinguish "no such
 * account" from "wrong password".
 */
@Controller('public')
export class SignupController {
  constructor(private prisma: PrismaService) {}

  @Post('signup')
  @Public()
  /*
   * Three a minute per address. Lower than login's five, because a genuine
   * applicant submits once and anything beyond a retry or two is noise.
   *
   * This is a floor, not a wall: it slows a script without pretending to stop a
   * distributed one. The real defence is that an application grants nothing —
   * it is a row a human has to approve — so the worst outcome of a flood is a
   * queue somebody has to clear, not access anybody gained. `submittedFromIp`
   * is stored so that clearing it can be done in one pass rather than fifty
   * separate decisions.
   */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @AuditAction('TENANT_APPLICATION_SUBMIT')
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    const email = dto.contactEmail.trim().toLowerCase();

    /*
     * Written through `unscoped`, deliberately.
     *
     * There is no tenant here — nobody is signed in and no hospital exists yet
     * — so `TenantInterceptor` has opened no transaction and the write proxy
     * has no tenant to stamp. `tenant_applications` carries the *inverted* RLS
     * policy (visible only when no hospital is in scope), which is exactly the
     * condition an anonymous request satisfies.
     */
    await this.prisma.unscoped.tenantApplication.create({
      data: {
        hospitalName: dto.hospitalName.trim(),
        requestedSlug: dto.requestedSlug?.trim() || null,
        contactName: dto.contactName.trim(),
        contactEmail: email,
        contactPhone: dto.contactPhone?.trim() || null,
        timezone: dto.timezone?.trim() || null,
        currency: dto.currency?.trim().toUpperCase() || null,
        notes: dto.notes?.trim() || null,
        submittedFromIp: req.ip ?? null,
      },
    });

    /*
     * The same answer for every caller.
     *
     * No id, because an id is a handle to something they cannot check and a
     * counter they could watch to estimate how many hospitals sign up. No
     * "we'll be in touch within N days" either — a promise the code cannot keep
     * and nothing here measures.
     */
    return {
      received: true,
      message:
        'Thank you — your request has been received. Someone will contact you at the address you gave.',
    };
  }
}
