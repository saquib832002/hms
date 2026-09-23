import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { LetterheadController } from './letterhead.controller';
import { DocumentsService } from './documents.service';
import { LabModule } from '../lab/lab.module';

@Module({
  /*
   * For `ensureAccession` only.
   *
   * A specimen label is the one document here that can bring a record into
   * existence rather than only rendering one: an order raised before
   * accessions existed has no number, and printing its label is somebody
   * deciding a tube is about to exist. Duplicating the allocation here would
   * give the hospital two sequences that can disagree, which is the one thing
   * a specimen number must never do.
   */
  imports: [LabModule],
  controllers: [DocumentsController, LetterheadController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
