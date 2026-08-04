import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { SaveListingDraftDto } from './dto/save-listing-draft.dto';
import { ListingDraft } from './entities/listing-draft.entity';
import {
  ListingDraftDetailDTO,
  ListingDraftSummaryDTO,
  toListingDraftDetailDTO,
  toListingDraftSummaryDTO,
} from './listing-draft-response';

// Coarse guard against a runaway autosave payload — a listing wizard draft is
// a few KB of form state, never megabytes. Rejected as a 400 rather than
// silently truncated so the frontend surfaces the failure.
const MAX_PAYLOAD_BYTES = 256 * 1024;

@Injectable()
export class ListingDraftsService {
  private readonly logger = new Logger(ListingDraftsService.name);

  constructor(
    @InjectRepository(ListingDraft)
    private readonly listingDrafts: Repository<ListingDraft>,
    private readonly config: ConfigService,
  ) {}

  /** `GET /listing-drafts` — the caller's own drafts, newest-edited first. */
  async list(userId: string): Promise<ListingDraftSummaryDTO[]> {
    const drafts = await this.listingDrafts.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
    return drafts.map(toListingDraftSummaryDTO);
  }

  /**
   * `POST /listing-drafts` — autosave upsert.
   *
   * - No `id`, or an `id` that does not resolve to a draft OWNED by this user:
   *   a brand-new draft is created with a fresh server-generated id and resume
   *   token, and that new id is returned. The supplied id is never trusted as
   *   a primary key (a caller can't forge or resurrect another user's row, and
   *   a draft deleted on another device simply becomes a new one instead of a
   *   404 that would break autosave).
   * - `id` resolves to the caller's own draft: its payload is replaced in
   *   place (the resume token is deliberately kept stable so a link already
   *   emailed for this draft keeps working).
   */
  async save(
    userId: string,
    dto: SaveListingDraftDto,
  ): Promise<{ id: string }> {
    this.assertPayloadSize(dto.payload);

    const existing = dto.id
      ? await this.listingDrafts.findOne({
          where: { id: dto.id, userId },
        })
      : null;

    if (existing) {
      existing.payload = dto.payload;
      const updated = await this.listingDrafts.save(existing);
      return { id: updated.id };
    }

    const created = await this.listingDrafts.save(
      this.listingDrafts.create({
        userId,
        payload: dto.payload,
        resumeToken: this.mintResumeToken(),
      }),
    );
    return { id: created.id };
  }

  /** `GET /listing-drafts/:id` — the caller's own draft, or 404. */
  async getById(userId: string, id: string): Promise<ListingDraftDetailDTO> {
    const draft = await this.loadOwnedOr404(userId, id);
    return toListingDraftDetailDTO(draft);
  }

  /** `DELETE /listing-drafts/:id`. */
  async remove(userId: string, id: string): Promise<void> {
    const draft = await this.loadOwnedOr404(userId, id);
    await this.listingDrafts.remove(draft);
  }

  /**
   * `POST /listing-drafts/:id/resume-link` — deliver the cross-device resume
   * link for one of the caller's own drafts to their own email address.
   *
   * The link is `<frontendUrl>/local/list-business?draft=<resumeToken>`, where
   * `frontendUrl` is the canonical origin (first `FRONTEND_URL` allowlist
   * entry) exactly as OAuth redirects and Mux URLs use it.
   *
   * NOTE ON DELIVERY: this platform ships with **no transactional mailer at
   * launch** — a documented, deliberate decision (`docs/ops/no-email-at-launch.md`,
   * mirrored by the `comingSoon` flag on the account email-preferences
   * surface). So the send is wired end-to-end (token, link, recipient) but the
   * actual dispatch is a log-only no-op today; the moment the Postmark mailer
   * lands this method swaps the `logger.log` for a real keyed send and nothing
   * else changes. The endpoint honestly returns 204 either way.
   */
  async sendResumeLink(
    userId: string,
    userEmail: string,
    id: string,
  ): Promise<void> {
    const draft = await this.loadOwnedOr404(userId, id);
    const resumeUrl = this.buildResumeUrl(draft.resumeToken);

    // TODO(mailer): replace with a real keyed transactional send once the
    // launch mailer exists — see docs/ops/no-email-at-launch.md. Recipient is
    // always the signed-in member's own address, never a caller-supplied one.
    this.logger.log(
      `Resume-link email is not delivered at launch (no mailer). ` +
        `Would send draft ${draft.id} resume link to ${userEmail}: ${resumeUrl}`,
    );
  }

  /**
   * `GET /listing-drafts/resume/:token` — resolve a resume token to its draft
   * so the frontend's `?draft=<token>` route can load it. Owner-scoped: a
   * token that belongs to a different user 404s exactly like an unknown token,
   * so nothing leaks whether a foreign token exists.
   */
  async resolveByToken(
    userId: string,
    token: string,
  ): Promise<ListingDraftDetailDTO> {
    const draft = await this.listingDrafts.findOne({
      where: { resumeToken: token, userId },
    });
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    return toListingDraftDetailDTO(draft);
  }

  private buildResumeUrl(resumeToken: string): string {
    const frontendUrl = this.config.getOrThrow<string>('app.frontendUrl');
    const resumeUrl = new URL('/local/list-business', frontendUrl);
    resumeUrl.searchParams.set('draft', resumeToken);
    return resumeUrl.toString();
  }

  private mintResumeToken(): string {
    return randomBytes(32).toString('hex');
  }

  private assertPayloadSize(payload: Record<string, unknown>): void {
    const byteLength = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (byteLength > MAX_PAYLOAD_BYTES) {
      throw new BadRequestException('Draft payload is too large.');
    }
  }

  private async loadOwnedOr404(
    userId: string,
    id: string,
  ): Promise<ListingDraft> {
    const draft = await this.listingDrafts.findOne({
      where: { id, userId },
    });
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    return draft;
  }
}
