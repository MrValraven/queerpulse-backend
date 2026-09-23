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

/** The member-facing pack plus the fields only an admin sees. */
export interface AdminStickerPackResponse extends StickerPackResponse {
  status: StickerPackStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AdminStickersService {
  constructor(
    @InjectRepository(StickerPack)
    private readonly packs: Repository<StickerPack>,
    @InjectRepository(Sticker)
    private readonly stickers: Repository<Sticker>,
  ) {}

  private toAdminResponse(pack: StickerPack): AdminStickerPackResponse {
    return {
      ...toStickerPackResponse(pack),
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

  async addSticker(
    packId: string,
    dto: CreateStickerDto,
    uploaderId: string,
  ): Promise<StickerResponse> {
    const pack = await this.loadPack(packId);
    // The key must be a well-formed `sticker` key this admin actually
    // uploaded, so nobody can point a sticker row at an unrelated object.
    if (parseStorageKey(dto.storageKey) !== UPLOAD_KIND_SPECS.sticker) {
      throw new BadRequestException('Not a sticker storage key');
    }
    if (storageKeyOwnerId(dto.storageKey) !== uploaderId) {
      throw new BadRequestException(
        'That sticker upload belongs to someone else',
      );
    }
    const duplicate = (pack.stickers ?? []).find(
      (sticker) => sticker.slug === dto.slug,
    );
    if (duplicate) {
      throw new ConflictException('That sticker slug is taken in this pack');
    }
    const serializedTemplateParams = JSON.stringify(dto.templateParams);
    if (serializedTemplateParams.length > MAX_TEMPLATE_PARAMS_LENGTH) {
      throw new BadRequestException(
        `templateParams must be at most ${MAX_TEMPLATE_PARAMS_LENGTH} characters serialized`,
      );
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
    const packStickerIds = new Set(
      (pack.stickers ?? []).map((sticker) => sticker.id),
    );
    const requestedStickerIds = new Set(dto.stickerIds);
    // A repeated id would make `dto.stickerIds.length` equal `packStickerIds.size`
    // while actually naming fewer distinct stickers than the pack holds, which
    // let a caller with A/B/C send [A, A, B] and pass the length-against-size
    // comparison this replaced. Checked on its own, against the ARRAY length
    // rather than the pack, so the message can name the real problem.
    if (requestedStickerIds.size !== dto.stickerIds.length) {
      throw new BadRequestException(
        'stickerIds must not repeat the same sticker twice',
      );
    }
    // Reordering a partial list would leave the omitted stickers holding
    // stale positions that collide with the new ones, so the payload must be
    // every sticker the pack holds, each named exactly once (the check above
    // already ruled out a repeat standing in for a missing one).
    const isCompleteList =
      requestedStickerIds.size === packStickerIds.size &&
      dto.stickerIds.every((stickerId) => packStickerIds.has(stickerId));
    if (!isCompleteList) {
      throw new BadRequestException('Send every sticker in the pack, in order');
    }
    await Promise.all(
      dto.stickerIds.map((stickerId, index) =>
        this.stickers.update({ id: stickerId, packId }, { sortOrder: index }),
      ),
    );
    return this.toAdminResponse(await this.loadPack(packId));
  }
}
