import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  toStoredPlainText,
  toStoredPlainTextOrNull,
} from '../communities/community-plain-text';
import { PAGE_SIZE, normalizePage } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminLegalRequestDTO,
  AdminLegalRequestPageDTO,
  toAdminLegalRequestDTO,
} from './legal-request-response';
import { CreateLegalRequestDto } from './dto/create-legal-request.dto';
import { ListLegalRequestsQuery } from './dto/list-legal-requests.query';
import { UpdateLegalRequestDto } from './dto/update-legal-request.dto';
import { VoidLegalRequestDto } from './dto/void-legal-request.dto';
import { LegalRequest } from './entities/legal-request.entity';
import {
  DISCLOSING_LEGAL_REQUEST_OUTCOMES,
  LegalRequestOutcome,
} from './legal-request-vocabulary';

/** Used when the recording admin has no profile row (a system or freshly
 *  bootstrapped staff account). Never their email: this snapshot is kept for
 *  years and an address is not what a colleague reading the register needs. */
const UNKNOWN_RECORDER_LABEL = 'Unknown';

/** The consistency rules a register row has to satisfy, checked against the
 *  MERGED record so a PATCH that touches one field is judged on the row it
 *  produces rather than on the keys it happened to send. */
interface LegalRequestInvariantView {
  accountsAffected: number;
  accountsNotified: number;
  memberNotifiedOn: string | null;
  notificationWithheldReason: string | null;
  outcome: LegalRequestOutcome;
}

/**
 * The register of legal, government and law-enforcement demands for member
 * data (PRD-32): the write side an admin drives, and the reads behind
 * `/admin/legal-requests`.
 *
 * The public Transparency Report published moderation figures and said nothing
 * at all about third-party legal demands, and an absent section on a queer
 * safety platform reads as an answer. This service owns the rows; the aggregate
 * over them is published by `TransparencyService`, which counts this table
 * directly and never loads a row from it.
 *
 * ## There is no delete
 *
 * Deliberately, and it is the reason this class exists rather than a generic
 * CRUD service. A register of state demands that can be quietly emptied is
 * worth less than no register, because its silence is still published as a
 * zero. A row entered in error is VOIDED: the row stays exactly where it is,
 * every published figure drops it, and the count of voided records is itself
 * published, so striking a record shows up as a number rather than as an
 * absence.
 *
 * ## What is written, and what is only recorded
 *
 * `accountsNotified` and `memberNotifiedOn` RECORD that the named members were
 * told. Nothing in this service tells anybody: it sends no notification and no
 * email, here or anywhere. An admin enters what the team actually did, and the
 * report publishes the total.
 */
@Injectable()
export class LegalRequestsService {
  constructor(
    @InjectRepository(LegalRequest)
    private readonly legalRequests: Repository<LegalRequest>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * One page of the register, newest demand first.
   *
   * Voided rows are included by default (`state=all`). A queue that hid them
   * would let a record be struck and then be hard to find again, which is the
   * failure the void-instead-of-delete rule exists to prevent; `state=voided`
   * lists exactly what has been struck.
   */
  async list(query: ListLegalRequestsQuery): Promise<AdminLegalRequestPageDTO> {
    const page = normalizePage(query.page);
    const registerQuery = this.legalRequests
      .createQueryBuilder('legalRequest')
      // Matches `IDX_legal_requests_received_on`. `id` breaks the tie so a page
      // is stable under offset pagination when several demands arrived on the
      // same day.
      .orderBy('legalRequest.receivedOn', 'DESC')
      .addOrderBy('legalRequest.id', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    if (query.state === 'active') {
      registerQuery.andWhere('legalRequest.voidedAt IS NULL');
    } else if (query.state === 'voided') {
      registerQuery.andWhere('legalRequest.voidedAt IS NOT NULL');
    }
    if (query.requestType) {
      registerQuery.andWhere('legalRequest.requestType = :requestType', {
        requestType: query.requestType,
      });
    }
    if (query.outcome) {
      registerQuery.andWhere('legalRequest.outcome = :outcome', {
        outcome: query.outcome,
      });
    }

    const [rows, total] = await registerQuery.getManyAndCount();
    return {
      items: rows.map(toAdminLegalRequestDTO),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  /** One record in full, for the register's detail pane. */
  async findOne(id: string): Promise<AdminLegalRequestDTO> {
    return toAdminLegalRequestDTO(await this.requireRecord(id));
  }

  /**
   * Record a demand. `outcome` defaults to `pending` at the column, so a
   * subpoena can be entered the hour it lands and answered later. That is the
   * intended flow: the register's value comes from rows being written
   * immediately.
   */
  async create(
    actorUserId: string,
    dto: CreateLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    const outcome = dto.outcome ?? LegalRequestOutcome.Pending;
    const accountsAffected = dto.accountsAffected ?? 0;
    const accountsNotified = dto.accountsNotified ?? 0;
    const memberNotifiedOn = dto.memberNotifiedOn ?? null;
    const notificationWithheldReason = toStoredPlainTextOrNull(
      dto.notificationWithheldReason,
    );

    assertInvariants({
      accountsAffected,
      accountsNotified,
      memberNotifiedOn,
      notificationWithheldReason,
      outcome,
    });

    const record = this.legalRequests.create({
      // Stripped once here at the write boundary rather than at every render
      // site: a crafted API call bypasses whatever the admin pane does on the
      // way in, and these columns are read back into a staff surface.
      requestingBody: toStoredPlainText(dto.requestingBody),
      jurisdiction: toStoredPlainText(dto.jurisdiction),
      requestType: dto.requestType,
      receivedOn: dto.receivedOn,
      accountsAffected,
      outcome,
      dataDisclosed: dto.dataDisclosed ?? [],
      memberNotifiedOn,
      accountsNotified,
      notificationWithheldReason,
      isUnderGagOrder: dto.isUnderGagOrder ?? false,
      internalNote: toStoredPlainTextOrNull(dto.internalNote),
      recordedByUserId: actorUserId,
      recordedByName: await this.recorderLabelFor(actorUserId),
      // Written explicitly rather than left to the column defaults, so the
      // saved object is complete in memory and a freshly recorded demand can
      // never read back as a struck one.
      voidedAt: null,
      voidedByUserId: null,
      voidReason: null,
    });
    return toAdminLegalRequestDTO(await this.legalRequests.save(record));
  }

  /**
   * Amend a record. Only the keys actually present are written, so a demand
   * entered as `pending` on the day it arrived can be completed later without
   * restating what is already on file. An explicit `null` clears a nullable
   * field.
   *
   * A voided record is frozen: 409 rather than a silent edit. Striking a
   * record is the register's one irreversible move, and a struck row that
   * could still be rewritten would let the reason it was struck disagree with
   * what it now says.
   */
  async update(
    id: string,
    dto: UpdateLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    const record = await this.requireRecord(id);
    if (record.voidedAt !== null) {
      throw new ConflictException('A voided legal request cannot be amended');
    }

    if (dto.requestingBody !== undefined) {
      record.requestingBody = toStoredPlainText(dto.requestingBody);
    }
    if (dto.jurisdiction !== undefined) {
      record.jurisdiction = toStoredPlainText(dto.jurisdiction);
    }
    if (dto.requestType !== undefined) record.requestType = dto.requestType;
    if (dto.receivedOn !== undefined) record.receivedOn = dto.receivedOn;
    if (dto.accountsAffected !== undefined) {
      record.accountsAffected = dto.accountsAffected;
    }
    if (dto.outcome !== undefined) record.outcome = dto.outcome;
    if (dto.dataDisclosed !== undefined) {
      record.dataDisclosed = dto.dataDisclosed;
    }
    if (dto.memberNotifiedOn !== undefined) {
      record.memberNotifiedOn = dto.memberNotifiedOn ?? null;
    }
    if (dto.accountsNotified !== undefined) {
      record.accountsNotified = dto.accountsNotified;
    }
    if (dto.notificationWithheldReason !== undefined) {
      record.notificationWithheldReason = toStoredPlainTextOrNull(
        dto.notificationWithheldReason,
      );
    }
    if (dto.isUnderGagOrder !== undefined) {
      record.isUnderGagOrder = dto.isUnderGagOrder;
    }
    if (dto.internalNote !== undefined) {
      record.internalNote = toStoredPlainTextOrNull(dto.internalNote);
    }

    assertInvariants(record);
    return toAdminLegalRequestDTO(await this.legalRequests.save(record));
  }

  /**
   * Strike a record from the published figures without removing it.
   *
   * The reason is required and stored, `voidedAt` and `voidedByUserId` are
   * stamped, and the row is untouched otherwise. Voiding is not idempotent on
   * purpose: re-voiding is 409 rather than a second stamp, so the register
   * keeps the moment and the reason a record was actually struck instead of
   * the last time somebody clicked.
   */
  async voidRecord(
    id: string,
    actorUserId: string,
    dto: VoidLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    const record = await this.requireRecord(id);
    if (record.voidedAt !== null) {
      throw new ConflictException('That legal request is already voided');
    }
    record.voidedAt = new Date();
    record.voidedByUserId = actorUserId;
    record.voidReason = toStoredPlainText(dto.reason);
    return toAdminLegalRequestDTO(await this.legalRequests.save(record));
  }

  private async requireRecord(id: string): Promise<LegalRequest> {
    const record = await this.legalRequests.findOne({ where: { id } });
    if (!record) throw new NotFoundException('Legal request not found');
    return record;
  }

  private async recorderLabelFor(userId: string): Promise<string> {
    const profile = await this.profiles.findOne({
      where: { userId },
      select: { userId: true, firstName: true, lastName: true },
    });
    if (!profile) return UNKNOWN_RECORDER_LABEL;
    return (
      `${profile.firstName} ${profile.lastName}`.trim() ||
      UNKNOWN_RECORDER_LABEL
    );
  }
}

/**
 * The four rules that keep a register row from saying two things at once.
 * Every one of them is a 400 rather than a saved contradiction, because this
 * table's totals are published and a row that disagrees with itself moves a
 * public number in a direction nobody chose.
 *
 *  1. Nobody can be notified who was not affected. The database enforces this
 *     too (`CHK_legal_requests_accounts_notified_within_affected`); catching it
 *     here turns a 500 into an answer the operator can act on.
 *  2. A notified count needs the day it happened, and
 *  3. a notification day needs a count, so "we told them" is never half a
 *     record. The report publishes the count, and a count with no date behind
 *     it is a claim.
 *  4. Where data actually left the platform and nobody was told, the reason
 *     has to be on file. "We did not tell them" is then always a decision
 *     somebody wrote down rather than a blank nobody noticed.
 */
function assertInvariants(view: LegalRequestInvariantView): void {
  if (view.accountsNotified > view.accountsAffected) {
    throw new BadRequestException(
      'accountsNotified cannot exceed accountsAffected',
    );
  }
  if (view.accountsNotified > 0 && view.memberNotifiedOn === null) {
    throw new BadRequestException(
      'memberNotifiedOn is required once any account has been notified',
    );
  }
  if (view.accountsNotified === 0 && view.memberNotifiedOn !== null) {
    throw new BadRequestException(
      'accountsNotified is required alongside memberNotifiedOn',
    );
  }
  const hasDisclosed = DISCLOSING_LEGAL_REQUEST_OUTCOMES.includes(view.outcome);
  if (
    hasDisclosed &&
    view.accountsAffected > 0 &&
    view.accountsNotified === 0 &&
    view.notificationWithheldReason === null
  ) {
    throw new BadRequestException(
      'notificationWithheldReason is required when data was disclosed and no ' +
        'affected account was notified',
    );
  }
}
