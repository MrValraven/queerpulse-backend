import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  constructor(
    @InjectRepository(ListingDraft)
    private readonly listingDrafts: Repository<ListingDraft>,
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
   *   place (the resume token is deliberately kept stable so a resume link the
   *   member already carries for this draft keeps working).
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
   * `GET /listing-drafts/resume/:token` — resolve a resume token to its draft
   * so the frontend's `?draft=<token>` route can load it. Owner-scoped: a
   * token that belongs to a different user 404s exactly like an unknown token,
   * so nothing leaks whether a foreign token exists.
   *
   * NOTHING DELIVERS THIS TOKEN. QueerPulse delivers no email, so the platform
   * never hands the resume link to anyone: it works only for a member who
   * carries the `?draft=<token>` URL across devices themselves. The drafts LIST
   * (`GET /listing-drafts`) is the cross-device path that needs no link at all.
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
