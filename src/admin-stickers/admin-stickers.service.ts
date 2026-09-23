import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { Sticker } from '../stickers/entities/sticker.entity';
import {
  StickerPack,
  StickerPackStatus,
} from '../stickers/entities/sticker-pack.entity';
import {
  StickerPackResponse,
  StickerResponse,
  toStickerPackResponse,
  toStickerResponse,
} from '../stickers/sticker-response';
import { CreateStickerDto } from './dto/create-sticker.dto';
import { CreateStickerPackDto } from './dto/create-sticker-pack.dto';
import { ReorderStickersDto } from './dto/reorder-stickers.dto';
import { UpdateStickerDto } from './dto/update-sticker.dto';
import { UpdateStickerPackDto } from './dto/update-sticker-pack.dto';

/**
 * Longest serialized `templateParams` a sticker may carry. `CreateStickerDto`
 * bounds every other field explicitly; this one only had `@IsObject()`, which
 * accepts any depth and any size. Twenty times the roughly 200 bytes the Uno
 * template actually produces, matching how `SubprofilesService.assertJsonbSize`
 * bounds its own loosely-shaped `@IsObject()` fields in the service rather than
 * in the DTO: this keeps the serialized payload bounded while leaving full
 * shape validation of template-specific params for later. A later template
 * with more knobs that needs more room raises this one constant.
 */
const MAX_TEMPLATE_PARAMS_LENGTH = 4096;

/** A sticker as an admin sees it: the member-facing fields plus what the
 *  builder needs to rebuild or replace its artwork. */
export interface AdminStickerResponse extends StickerResponse {
  templateId: string;
  templateParams: Record<string, unknown>;
  sortOrder: number;
}

/** The member-facing pack plus the fields only an admin sees. */
export interface AdminStickerPackResponse extends StickerPackResponse {
  status: StickerPackStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  stickers: AdminStickerResponse[];
}

@Injectable()
export class AdminStickersService {
  constructor(
    @InjectRepository(StickerPack)
    private readonly packs: Repository<StickerPack>,
    @InjectRepository(Sticker)
    private readonly stickers: Repository<Sticker>,
  ) {}

  /** Adds `templateId`, `templateParams` and `sortOrder` to `toStickerResponse`,
   *  returning null on the same unresolvable-storage-key case that function does. */
  private toAdminStickerResponse(
    sticker: Sticker,
  ): AdminStickerResponse | null {
    const stickerResponse = toStickerResponse(sticker);
    if (!stickerResponse) return null;
    return {
      ...stickerResponse,
      templateId: sticker.templateId,
      templateParams: sticker.templateParams,
      sortOrder: sticker.sortOrder,
    };
  }

  private toAdminResponse(pack: StickerPack): AdminStickerPackResponse {
    // Mirrors `toStickerPackResponse`'s own ordering and null-skip behaviour
    // (sort by `sortOrder`, drop a sticker whose storage key does not
    // resolve), reusing `toAdminStickerResponse` in place of `toStickerResponse`
    // to carry the three admin-only fields along.
    const stickers = [...(pack.stickers ?? [])]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((sticker) => this.toAdminStickerResponse(sticker))
      .filter((sticker): sticker is AdminStickerResponse => sticker !== null);
    return {
      ...toStickerPackResponse(pack),
      stickers,
      status: pack.status,
      sortOrder: pack.sortOrder,
      createdAt: pack.createdAt.toISOString(),
      updatedAt: pack.updatedAt.toISOString(),
    };
  }

  private async loadPack(packId: string): Promise<StickerPack> {
    const pack = await this.packs.findOne({
      where: { id: packId },
      relations: { stickers: true },
    });
    if (!pack) throw new NotFoundException('Sticker pack not found');
    return pack;
  }

  async listPacks(): Promise<AdminStickerPackResponse[]> {
    const packs = await this.packs.find({
      relations: { stickers: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return packs.map((pack) => this.toAdminResponse(pack));
  }

  async createPack(
    dto: CreateStickerPackDto,
    createdById: string,
  ): Promise<AdminStickerPackResponse> {
    const existing = await this.packs.findOne({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException('That pack slug is taken');
    const saved = await this.packs.save(
      this.packs.create({
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        status: StickerPackStatus.Draft,
        createdById,
      }),
    );
    return this.toAdminResponse(await this.loadPack(saved.id));
  }

  async updatePack(
    packId: string,
    dto: UpdateStickerPackDto,
  ): Promise<AdminStickerPackResponse> {
    const pack = await this.loadPack(packId);
    // Publishing an empty pack would put a blank tab in every member's
    // composer, so it is refused rather than silently allowed.
    if (
      dto.status === StickerPackStatus.Published &&
      (pack.stickers ?? []).length === 0
    ) {
      throw new BadRequestException(
        'A pack needs at least one sticker to publish',
      );
    }
    if (dto.coverStickerId) {
      const isInPack = (pack.stickers ?? []).some(
        (sticker) => sticker.id === dto.coverStickerId,
      );
      if (!isInPack) {
        throw new BadRequestException(
          'The cover must be a sticker in this pack',
        );
      }
      pack.coverStickerId = dto.coverStickerId;
    }
    if (dto.name !== undefined) pack.name = dto.name;
    if (dto.description !== undefined) pack.description = dto.description;
    if (dto.status !== undefined) pack.status = dto.status;
    if (dto.sortOrder !== undefined) pack.sortOrder = dto.sortOrder;
    await this.packs.save(pack);
    return this.toAdminResponse(await this.loadPack(packId));
  }

  async deletePack(packId: string): Promise<void> {
    const pack = await this.packs.findOne({ where: { id: packId } });
    if (!pack) throw new NotFoundException('Sticker pack not found');
    if (pack.status !== StickerPackStatus.Draft) {
      throw new ConflictException(
        'Only a draft pack can be deleted. Archive a published pack instead',
      );
    }
    // The pack's stickers go with it through the FK's `onDelete: 'CASCADE'`
    // on `Sticker.pack` (see that entity), so no separate sticker cleanup is
    // needed here.
    await this.packs.delete({ id: packId });
  }

  /**
   * Checks that `storageKey` is a well-formed `sticker` key this admin
   * actually uploaded, and that `templateParams` serializes within
   * `MAX_TEMPLATE_PARAMS_LENGTH`. Shared by `addSticker` and `updateSticker`,
   * the two paths that persist artwork onto a sticker row.
   */
  private assertValidArtwork(
    storageKey: string,
    templateParams: Record<string, unknown>,
    uploaderId: string,
  ): void {
    // The key must be a well-formed `sticker` key this admin actually
    // uploaded, so nobody can point a sticker row at an unrelated object.
    if (parseStorageKey(storageKey) !== UPLOAD_KIND_SPECS.sticker) {
      throw new BadRequestException('Not a sticker storage key');
    }
    if (storageKeyOwnerId(storageKey) !== uploaderId) {
      throw new BadRequestException(
        'That sticker upload belongs to someone else',
      );
    }
    const serializedTemplateParams = JSON.stringify(templateParams);
    if (serializedTemplateParams.length > MAX_TEMPLATE_PARAMS_LENGTH) {
      throw new BadRequestException(
        `templateParams must be at most ${MAX_TEMPLATE_PARAMS_LENGTH} characters serialized`,
      );
    }
  }

  async addSticker(
    packId: string,
    dto: CreateStickerDto,
    uploaderId: string,
  ): Promise<StickerResponse> {
    const pack = await this.loadPack(packId);
    this.assertValidArtwork(dto.storageKey, dto.templateParams, uploaderId);
    const duplicate = (pack.stickers ?? []).find(
      (sticker) => sticker.slug === dto.slug,
    );
    if (duplicate) {
      throw new ConflictException('That sticker slug is taken in this pack');
    }
    const nextSortOrder =
      dto.sortOrder ??
      (pack.stickers ?? []).reduce(
        (highest, sticker) => Math.max(highest, sticker.sortOrder + 1),
        0,
      );
    const saved = await this.stickers.save(
      this.stickers.create({
        packId,
        slug: dto.slug,
        label: dto.label,
        storageKey: dto.storageKey,
        width: dto.width,
        height: dto.height,
        svgSource: dto.svgSource,
        templateId: dto.templateId,
        templateParams: dto.templateParams,
        keywords: dto.keywords ?? { en: [], pt: [] },
        sortOrder: nextSortOrder,
      }),
    );
    // `toStickerResponse` returns null when the storage key does not resolve
    // to a URL, which is the right outcome for the member-facing read path
    // (skip one bad row rather than fail the whole catalogue) but the wrong
    // one here. The admin is right here, just uploaded this file, and needs
    // to be told loudly that the key does not resolve, rather than getting a
    // quiet 201 for a sticker nobody will ever see. Staying silent would
    // create exactly the corrupt row the read path then has to skip.
    const stickerResponse = toStickerResponse(saved);
    if (!stickerResponse) {
      throw new InternalServerErrorException(
        'The uploaded sticker key does not resolve to an image URL',
      );
    }
    return stickerResponse;
  }

  async updateSticker(
    packId: string,
    stickerId: string,
    dto: UpdateStickerDto,
    uploaderId: string,
  ): Promise<AdminStickerResponse> {
    // Checked with truthy tests so an explicit `null` counts as absent here:
    // `@IsOptional()` lets `null` through DTO validation the same as a
    // missing field, and `label`/`keywords` are NOT NULL columns, so a
    // `null` here must be treated exactly like the field was never sent,
    // both in this gate and in the assignments below.
    if (!dto.label && !dto.keywords && !dto.artwork) {
      throw new BadRequestException(
        'Send at least one of label, keywords or artwork to update',
      );
    }
    const sticker = await this.stickers.findOne({
      where: { id: stickerId, packId },
    });
    if (!sticker) throw new NotFoundException('Sticker not found');
    if (dto.artwork) {
      this.assertValidArtwork(
        dto.artwork.storageKey,
        dto.artwork.templateParams,
        uploaderId,
      );
      // The old storage object is never touched here: a sent message stores
      // the sticker's `url` at send time, so a chat that already used this
      // sticker keeps showing the old art until the old file is deleted,
      // which this method never does.
      sticker.storageKey = dto.artwork.storageKey;
      sticker.width = dto.artwork.width;
      sticker.height = dto.artwork.height;
      sticker.svgSource = dto.artwork.svgSource;
      sticker.templateId = dto.artwork.templateId;
      sticker.templateParams = dto.artwork.templateParams;
    }
    if (dto.label) sticker.label = dto.label;
    if (dto.keywords) sticker.keywords = dto.keywords;
    // `slug`, `id`, `sortOrder` and the pack's cover are never touched here:
    // an update replaces a sticker's content in place, keeping its identity
    // and its position.
    const saved = await this.stickers.save(sticker);
    const stickerResponse = this.toAdminStickerResponse(saved);
    if (!stickerResponse) {
      throw new InternalServerErrorException(
        'The uploaded sticker key does not resolve to an image URL',
      );
    }
    return stickerResponse;
  }

  async removeSticker(packId: string, stickerId: string): Promise<void> {
    const result = await this.stickers.delete({ id: stickerId, packId });
    if (!result.affected) throw new NotFoundException('Sticker not found');
    // A pack whose cover was the removed sticker falls back to "no cover"
    // rather than pointing at a row that is gone.
    await this.packs.update(
      { id: packId, coverStickerId: stickerId },
      { coverStickerId: null },
    );
  }

  async reorderStickers(
    packId: string,
    dto: ReorderStickersDto,
  ): Promise<AdminStickerPackResponse> {
    const pack = await this.loadPack(packId);
    const packStickers = pack.stickers ?? [];
    // The builder only ever shows the stickers `toStickerResponse` resolves
    // to a URL (the same rows `toAdminResponse` keeps), so those are the only
    // ones an admin can name in `dto.stickerIds`. Reusing `toStickerResponse`
    // here instead of re-deriving which keys resolve keeps that one
    // null-skip rule in one place.
    const visibleStickers = packStickers.filter(
      (sticker) => toStickerResponse(sticker) !== null,
    );
    const visibleStickerIds = new Set(
      visibleStickers.map((sticker) => sticker.id),
    );
    const requestedStickerIds = new Set(dto.stickerIds);
    // A repeated id would make `dto.stickerIds.length` equal `visibleStickerIds.size`
    // while actually naming fewer distinct stickers than are visible, which
    // let a caller with A/B/C send [A, A, B] and pass the length-against-size
    // comparison this replaced. Checked on its own, against the ARRAY length
    // rather than the visible set, so the message can name the real problem.
    if (requestedStickerIds.size !== dto.stickerIds.length) {
      throw new BadRequestException(
        'stickerIds must not repeat the same sticker twice',
      );
    }
    // Reordering a partial list would leave the omitted stickers holding
    // stale positions that collide with the new ones, so the payload must be
    // every VISIBLE sticker in the pack, each named exactly once (the check
    // above already ruled out a repeat standing in for a missing one). An id
    // that is not in `visibleStickerIds`, whether it belongs to a different
    // pack or names a sticker this admin cannot see, fails this check the
    // same way.
    const isCompleteList =
      requestedStickerIds.size === visibleStickerIds.size &&
      dto.stickerIds.every((stickerId) => visibleStickerIds.has(stickerId));
    if (!isCompleteList) {
      throw new BadRequestException('Send every sticker in the pack, in order');
    }
    // A sticker whose storage key does not resolve is invisible to the
    // builder and so can never be named in `dto.stickerIds`. It keeps a
    // stable position after every reordered sticker instead of colliding
    // with one of the new positions, and its relative order against the
    // other invisible stickers is preserved by sorting on the pack's
    // existing `sortOrder` before reassigning.
    const invisibleStickers = packStickers
      .filter((sticker) => !visibleStickerIds.has(sticker.id))
      .sort((left, right) => left.sortOrder - right.sortOrder);
    await Promise.all([
      ...dto.stickerIds.map((stickerId, index) =>
        this.stickers.update({ id: stickerId, packId }, { sortOrder: index }),
      ),
      ...invisibleStickers.map((sticker, index) =>
        this.stickers.update(
          { id: sticker.id, packId },
          { sortOrder: dto.stickerIds.length + index },
        ),
      ),
    ]);
    return this.toAdminResponse(await this.loadPack(packId));
  }
}
