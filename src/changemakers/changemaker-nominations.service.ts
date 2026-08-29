import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { CreateChangemakerNominationDto } from './dto/create-changemaker-nomination.dto';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import {
  ChangemakerNominationResponseDTO,
  toChangemakerNominationResponse,
} from './changemaker-nomination-response';

@Injectable()
export class ChangemakerNominationsService {
  constructor(
    @InjectRepository(ChangemakerNomination)
    private readonly changemakerNominations: Repository<ChangemakerNomination>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async create(
    nominatorId: string,
    dto: CreateChangemakerNominationDto,
  ): Promise<ChangemakerNominationResponseDTO> {
    const nomineeUserId = await this.resolveNominee(nominatorId, dto);
    const saved = await this.changemakerNominations.save(
      this.changemakerNominations.create({
        nominatorId,
        nomineeName: dto.nomineeName.trim(),
        reason: dto.reason.trim(),
        nomineeUserId,
        nomineeContact: dto.nomineeContact?.trim() || null,
      }),
    );
    return toChangemakerNominationResponse(saved);
  }

  /**
   * COM-18: turns the form's optional member pick into a stored `userId`.
   *
   * An unresolvable slug is a 400 rather than a silently dropped null. The
   * picker only ever submits a slug it got back from `GET /search?type=member`
   * a moment earlier, so failing here means the nominator's pick no longer
   * points at an active member — and quietly saving the nomination without it
   * would tell them their pick was recorded when it was not.
   *
   * Nominating yourself is also a 400. Change Makers is a curated directory a
   * moderator opens a story from, and the whole surface is built around a
   * member putting SOMEONE ELSE forward (the copy, the queue's
   * "Nominated by {name}" line, the note promising the nominee is not told).
   * A self-nomination is a different request — "cover me" — and it should not
   * arrive disguised as community recognition.
   */
  private async resolveNominee(
    nominatorId: string,
    dto: CreateChangemakerNominationDto,
  ): Promise<string | null> {
    const slug = dto.nomineeSlug?.trim();
    if (!slug) return null;

    // Restricted to profiles of active users by `MemberLookup` itself.
    const nomineeUserId = await new MemberLookup(this.profiles).userIdForSlug(
      slug,
    );
    if (!nomineeUserId) {
      throw new BadRequestException('That member could not be found');
    }
    if (nomineeUserId === nominatorId) {
      throw new BadRequestException('You cannot nominate yourself');
    }
    return nomineeUserId;
  }
}
