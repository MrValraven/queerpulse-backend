import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { MailerService } from '../mailer/mailer.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import {
  InquiryAckDTO,
  InquiryDTO,
  toInquiryAckDTO,
  toInquiryDTO,
} from './inquiries-response';
import { Inquiry } from './entities/inquiry.entity';

/**
 * Stores public marketing-form submissions (Contact + partnership) and pings
 * ops so a message is never lost between a member sending it and staff seeing
 * it in the admin list. The notification goes through the shared
 * {@link MailerService}, which is log-only until SMTP env is set — so in dev the
 * inquiry is persisted and its arrival logged, and the moment real SMTP creds
 * exist the same code delivers to the ops inbox.
 */
@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    @InjectRepository(Inquiry)
    private readonly inquiries: Repository<Inquiry>,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Persist a new inquiry (`status = 'new'`) and notify ops. The row is saved
   * first; a mail failure is logged but never fails the request — the caller's
   * message is already safely stored for triage, so a flaky mailer must not tell
   * a visitor their message bounced.
   */
  async create(dto: CreateInquiryDto): Promise<InquiryAckDTO> {
    const inquiry = await this.inquiries.save(
      this.inquiries.create({
        kind: dto.kind,
        senderName: dto.name,
        email: dto.email,
        subject: dto.subject ?? null,
        body: dto.body,
        orgName: dto.orgName ?? null,
        status: 'new',
      }),
    );

    await this.notifyOps(inquiry);

    return toInquiryAckDTO(inquiry);
  }

  /** Admin triage list, newest first. Bounded — not real pagination. */
  async list(): Promise<InquiryDTO[]> {
    const rows = await this.inquiries.find({
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toInquiryDTO);
  }

  private async notifyOps(inquiry: Inquiry): Promise<void> {
    const to =
      this.config.get<string>('mail.opsInbox') ??
      this.config.get<string>('mail.from');
    if (!to) {
      // No ops recipient configured and no MAIL_FROM fallback — the row is still
      // saved and visible in the admin list; skip the mail rather than throw.
      this.logger.warn(
        `Inquiry ${inquiry.id} saved but not emailed: no ops inbox configured.`,
      );
      return;
    }
    try {
      await this.mailer.send(to, 'ops_inquiry_received', {
        kind: inquiry.kind,
        senderName: inquiry.senderName,
        senderEmail: inquiry.email,
        subject: inquiry.subject ?? undefined,
        orgName: inquiry.orgName ?? undefined,
        body: inquiry.body,
      });
    } catch (error) {
      this.logger.error(
        `Inquiry ${inquiry.id} saved but ops email failed: ${String(error)}`,
      );
    }
  }
}
