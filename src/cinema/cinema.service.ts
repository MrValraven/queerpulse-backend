import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { CreateTitleDto } from './dto/create-title.dto';
import { UpdateTitleDto } from './dto/update-title.dto';
import { CinemaTitle, TitleStatus } from './entities/cinema-title.entity';
import { WatchProgress } from './entities/watch-progress.entity';
import { MuxService, PlaybackTokens } from './mux.service';
import {
  TitleDetail,
  TitleListItem,
  isFinished,
  toTitleDetail,
  toTitleListItem,
} from './title-response';

export type PlaybackSession = PlaybackTokens & {
  resumePositionSeconds: number;
  durationSeconds: number | null;
};

const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

function isModerator(user: CurrentUserData): boolean {
  return MODERATOR_ROLES.includes(user.role);
}

@Injectable()
export class CinemaService {
  private readonly logger = new Logger(CinemaService.name);

  constructor(
    @InjectRepository(CinemaTitle)
    private readonly titles: Repository<CinemaTitle>,
    @InjectRepository(WatchProgress)
    private readonly progress: Repository<WatchProgress>,
    private readonly mux: MuxService,
    private readonly dataSource: DataSource,
  ) {}

  async listTitles(
    user: CurrentUserData,
    includeAll: boolean,
  ): Promise<TitleListItem[]> {
    if (includeAll && !isModerator(user)) {
      throw new ForbiddenException('Moderator role required');
    }
    const rows = includeAll
      ? await this.titles.find({ order: { createdAt: 'DESC' } })
      : await this.titles.find({
          where: { status: TitleStatus.Ready, publishedAt: Not(IsNull()) },
          order: { publishedAt: 'DESC' },
        });
    const progressByTitle = await this.progressFor(
      user.userId,
      rows.map((row) => row.id),
    );
    return rows.map((row) =>
      toTitleListItem(row, progressByTitle.get(row.id) ?? null),
    );
  }

  async getTitle(user: CurrentUserData, id: string): Promise<TitleDetail> {
    const title = await this.getVisibleTitle(user, id);
    const myProgress = await this.progress.findOne({
      where: { userId: user.userId, titleId: id },
    });
    return toTitleDetail(title, myProgress, isModerator(user));
  }

  async createPlaybackSession(
    user: CurrentUserData,
    id: string,
  ): Promise<PlaybackSession> {
    const title = await this.titles.findOne({ where: { id } });
    // Entitlement (spec §6): active member (guard) + published & ready title.
    // Moderators/admins may preview unpublished ready titles. 404 (not 403)
    // for anything invisible so existence is not leaked.
    if (
      !title ||
      title.status !== TitleStatus.Ready ||
      (!title.publishedAt && !isModerator(user))
    ) {
      throw new NotFoundException('Title not found');
    }
    if (!title.muxPlaybackId) {
      throw new ConflictException('Title has no playable asset');
    }
    const tokens = await this.mux.signPlaybackTokens(
      title.muxPlaybackId,
      title.durationSeconds,
    );
    const myProgress = await this.progress.findOne({
      where: { userId: user.userId, titleId: id },
    });
    const resumePositionSeconds =
      myProgress && !isFinished(title, myProgress.positionSeconds)
        ? myProgress.positionSeconds
        : 0;
    return {
      ...tokens,
      resumePositionSeconds,
      durationSeconds: title.durationSeconds,
    };
  }

  async createTitle(
    user: CurrentUserData,
    dto: CreateTitleDto,
  ): Promise<TitleDetail> {
    const title = await this.titles.save(
      this.titles.create({
        kind: dto.kind,
        title: dto.title,
        description: dto.description ?? null,
        coverImageUrl: dto.coverImageUrl ?? null,
        status: TitleStatus.Draft,
        createdBy: { id: user.userId } as User,
      }),
    );
    return toTitleDetail(title, null, true);
  }

  async updateTitle(id: string, dto: UpdateTitleDto): Promise<TitleDetail> {
    const title = await this.titles.findOne({ where: { id } });
    if (!title) {
      throw new NotFoundException('Title not found');
    }
    if (dto.kind !== undefined) title.kind = dto.kind;
    if (dto.title !== undefined) title.title = dto.title;
    if (dto.description !== undefined) title.description = dto.description;
    if (dto.coverImageUrl !== undefined) {
      title.coverImageUrl = dto.coverImageUrl;
    }
    if (dto.published === true) {
      if (title.status !== TitleStatus.Ready) {
        throw new BadRequestException('Title is not ready to publish');
      }
      title.publishedAt = title.publishedAt ?? new Date();
    } else if (dto.published === false) {
      title.publishedAt = null;
    }
    const saved = await this.titles.save(title);
    return toTitleDetail(saved, null, true);
  }

  async deleteTitle(id: string): Promise<void> {
    const title = await this.titles.findOne({ where: { id } });
    if (!title) {
      throw new NotFoundException('Title not found');
    }
    // Best-effort provider cleanup: an unreachable Mux must not block
    // deleting the catalog entry; orphans surface in the Mux dashboard.
    for (const assetId of [title.muxAssetId, title.pendingMuxAssetId]) {
      if (assetId) {
        await this.deleteAssetBestEffort(assetId, id);
      }
    }
    await this.titles.remove(title);
  }

  async requestUpload(
    id: string,
  ): Promise<{ uploadId: string; uploadUrl: string }> {
    const title = await this.titles.findOne({ where: { id } });
    if (!title) {
      throw new NotFoundException('Title not found');
    }
    if (title.status === TitleStatus.Processing) {
      throw new ConflictException('Upload already processing');
    }
    const upload = await this.mux.createDirectUpload(title.id);
    if (title.status === TitleStatus.Ready) {
      // Replacement: the title stays published and playable on the current
      // asset until the new one reaches ready (swap happens in onAssetReady).
      title.pendingMuxUploadId = upload.uploadId;
      title.pendingMuxAssetId = null;
    } else {
      // draft | awaiting_upload | failed
      if (title.muxAssetId) {
        await this.deleteAssetBestEffort(title.muxAssetId, title.id);
        title.muxAssetId = null;
      }
      title.muxUploadId = upload.uploadId;
      title.muxPlaybackId = null;
      title.status = TitleStatus.AwaitingUpload;
      title.errorMessage = null;
    }
    await this.titles.save(title);
    return upload;
  }

  // --- webhook/reconciliation state transitions (idempotent; unknown ids
  // are ignored — Mux retries and can deliver out of order) ---

  async onUploadAssetCreated(uploadId: string, assetId: string): Promise<void> {
    const title = await this.titles.findOne({
      where: [{ muxUploadId: uploadId }, { pendingMuxUploadId: uploadId }],
    });
    if (!title) {
      return;
    }
    if (title.pendingMuxUploadId === uploadId) {
      if (title.pendingMuxAssetId === assetId) {
        return; // replay
      }
      title.pendingMuxAssetId = assetId;
    } else {
      if (title.muxAssetId === assetId) {
        return; // replay
      }
      title.muxAssetId = assetId;
      if (title.status === TitleStatus.AwaitingUpload) {
        title.status = TitleStatus.Processing;
      }
    }
    await this.titles.save(title);
  }

  async onAssetReady(
    assetId: string,
    meta: {
      playbackId: string | null;
      durationSeconds: number | null;
      aspectRatio: string | null;
    },
  ): Promise<void> {
    const title = await this.titles.findOne({
      where: [{ muxAssetId: assetId }, { pendingMuxAssetId: assetId }],
    });
    if (!title) {
      return;
    }
    if (title.pendingMuxAssetId === assetId) {
      // Replacement swap: promote pending ids, keep publish state untouched,
      // then drop the superseded asset at Mux.
      const oldAssetId = title.muxAssetId;
      title.muxAssetId = assetId;
      title.muxUploadId = title.pendingMuxUploadId;
      title.pendingMuxAssetId = null;
      title.pendingMuxUploadId = null;
      this.applyReadyMeta(title, meta);
      await this.titles.save(title);
      if (oldAssetId) {
        await this.deleteAssetBestEffort(oldAssetId, title.id);
      }
      return;
    }
    if (
      title.status === TitleStatus.Ready &&
      title.muxPlaybackId === meta.playbackId
    ) {
      return; // replay
    }
    this.applyReadyMeta(title, meta);
    await this.titles.save(title);
  }

  async onAssetErrored(assetId: string, message: string): Promise<void> {
    const title = await this.titles.findOne({
      where: [{ muxAssetId: assetId }, { pendingMuxAssetId: assetId }],
    });
    if (!title) {
      return;
    }
    if (title.pendingMuxAssetId === assetId) {
      // Failed replacement: the live asset keeps serving viewers.
      title.pendingMuxAssetId = null;
      title.pendingMuxUploadId = null;
      title.errorMessage = `Replacement failed: ${message}`;
    } else {
      title.status = TitleStatus.Failed;
      title.errorMessage = message;
    }
    await this.titles.save(title);
  }

  async onUploadFailed(uploadId: string, message: string): Promise<void> {
    const title = await this.titles.findOne({
      where: [{ muxUploadId: uploadId }, { pendingMuxUploadId: uploadId }],
    });
    if (!title) {
      return;
    }
    if (title.pendingMuxUploadId === uploadId) {
      title.pendingMuxUploadId = null;
      title.pendingMuxAssetId = null;
      title.errorMessage = `Replacement failed: ${message}`;
    } else {
      title.status = TitleStatus.Failed;
      title.errorMessage = message;
    }
    await this.titles.save(title);
  }

  private applyReadyMeta(
    title: CinemaTitle,
    meta: {
      playbackId: string | null;
      durationSeconds: number | null;
      aspectRatio: string | null;
    },
  ): void {
    title.muxPlaybackId = meta.playbackId;
    title.durationSeconds = meta.durationSeconds;
    title.aspectRatio = meta.aspectRatio;
    title.status = TitleStatus.Ready;
    title.errorMessage = null;
  }

  private async deleteAssetBestEffort(
    assetId: string,
    titleId: string,
  ): Promise<void> {
    try {
      await this.mux.deleteAsset(assetId);
    } catch (err) {
      this.logger.warn(
        `Failed to delete Mux asset ${assetId} for title ${titleId}: ${String(err)}`,
      );
    }
  }

  async reportProgress(
    user: CurrentUserData,
    titleId: string,
    positionSeconds: number,
  ): Promise<{ positionSeconds: number; viewCounted: boolean }> {
    const title = await this.titles.findOne({ where: { id: titleId } });
    if (
      !title ||
      title.status !== TitleStatus.Ready ||
      (!title.publishedAt && !isModerator(user))
    ) {
      throw new NotFoundException('Title not found');
    }
    // Small grace over duration: player time can overshoot the last segment.
    if (
      title.durationSeconds != null &&
      positionSeconds > title.durationSeconds + 5
    ) {
      throw new BadRequestException('Position exceeds title duration');
    }

    await this.progress.upsert(
      { userId: user.userId, titleId, positionSeconds },
      { conflictPaths: ['userId', 'titleId'] },
    );

    // A view counts once per user per title, when progress first crosses
    // min(60 s, 50% of duration) — the 50% arm covers very short films.
    const threshold = Math.min(
      60,
      Math.ceil((title.durationSeconds ?? 120) * 0.5),
    );
    let viewCounted = false;
    if (positionSeconds >= threshold) {
      await this.dataSource.transaction(async (manager) => {
        // The IS NULL guard makes racing/repeated reports count exactly once.
        const marked = await manager
          .createQueryBuilder()
          .update(WatchProgress)
          .set({ viewCountedAt: () => 'now()' })
          .where(
            'user_id = :userId AND title_id = :titleId AND view_counted_at IS NULL',
            { userId: user.userId, titleId },
          )
          .execute();
        if (marked.affected === 1) {
          await manager.increment(CinemaTitle, { id: titleId }, 'viewCount', 1);
          viewCounted = true;
        }
      });
    }
    return { positionSeconds, viewCounted };
  }

  private async getVisibleTitle(
    user: CurrentUserData,
    id: string,
  ): Promise<CinemaTitle> {
    const title = await this.titles.findOne({ where: { id } });
    const visible =
      title &&
      (isModerator(user) ||
        (title.status === TitleStatus.Ready && title.publishedAt !== null));
    if (!title || !visible) {
      throw new NotFoundException('Title not found');
    }
    return title;
  }

  private async progressFor(
    userId: string,
    titleIds: string[],
  ): Promise<Map<string, WatchProgress>> {
    if (titleIds.length === 0) {
      return new Map();
    }
    const rows = await this.progress.find({
      where: { userId, titleId: In(titleIds) },
    });
    return new Map(rows.map((row) => [row.titleId, row]));
  }
}
