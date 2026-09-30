import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Global, like the audit module, and for a similar reason: what it does is not
 * a feature of any one domain, and the alternative is importing it into every
 * module that ever needs to tell somebody something.
 *
 * It is the only outbound channel in this system apart from push, and push
 * carries no free text by design. Keeping it in one place is what makes "what
 * does this product send to people, and what is in it" an answerable question.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
