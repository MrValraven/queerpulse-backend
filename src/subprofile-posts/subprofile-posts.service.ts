import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  LessThan,
  MoreThan,
  Repository,
} from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { NotificationType } from '../notifications/entities/notification.entity';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import {
  isPersonaScopedExtension,
  isPersonaScopedKey,
  isStorageKey,
  storageKeyOwnerId,
} from '../storage/storage-key';
import { isPrivateMessageKey } from '../storage/upload-kinds';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import { CreatePersonaPostDto } from './dto/create-persona-post.dto';
import { UpdatePersonaPostDto } from './dto/update-persona-post.dto';
import { SubprofilePostQuotaEntry } from './entities/subprofile-post-quota-entry.entity';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { PersonaPostAlertsService } from './persona-post-alerts.service';
import {
  decodePersonaPostCursor,
  encodePersonaPostCursor,
} from './persona-post-cursor';
import {
  EMPTY_PERSONA_POST_PAGE,
  PersonaPost,
  PersonaPostPage,
  toPersonaPost,
} from './persona-post-response';
import {
  PERSONA_POST,
  PERSONA_POST_QUOTA_WINDOW_MILLISECONDS,
  isPersonaPostKind,
  personaPostError,
} from './persona-post.constants';

/** An uploaded image key a post photo may come from: a storage key outside
 *  the message attachment kinds, with an image extension a persona-scoped
 *  copy can carry. */
export function isUsablePostImageKey(value: string): boolean {
  if (!isStorageKey(value) || isPrivateMessageKey(value)) {
    return false;
  }
  return isPersonaScopedExtension(value.slice(value.lastIndexOf('.')));
}

/** The follower bells a post's alert wrote (`payload.postId` names it). */
export const PERSONA_POST_NOTIFICATIONS_DELETE_SQL = `DELETE FROM "notifications" WHERE "type" = '${NotificationType.PersonaPost}' AND "payload" ->> 'postId' = $1`;

/**
 * After the commit and best effort: a post staff removed takes its follower
 * bells with it, so abusive text leaves every inbox. Only the staff removal
 * (`SubprofilePostModerationService.removePost`) calls this; an owner's own
 * delete leaves the bells to age out, because a bundled bell may already
 * show a newer post. A failure is logged at warn and the removal stands.
 */
export async function deletePersonaPostNotifications(
  dataSource: DataSource,
  logger: Logger,
  postId: string,
): Promise<void> {
  try {
    await dataSource.query(PERSONA_POST_NOTIFICATIONS_DELETE_SQL, [postId]);
  } catch (error) {
    logger.warn(
      `Bells for persona post ${postId} were not deleted: ${String(error)}`,
    );
  }
}

/**
 * Studio v3 persona posts. Reads follow the persona page exactly
 * (`resolveReadablePersona`). Writes belong to the persona's owners and
 * co-owners; anyone else gets the same 404 a missing post gives, and a
 * removed persona answers 404 `Persona not found` to its owners too. A create
 * runs under a `FOR NO KEY UPDATE` lock on the persona row, so two posts
 * sent together cannot both slip under the daily limit; the limit and the
 * alert throttle count the 24 hour ledger, which a delete leaves alone. A
 * photo is always stored as a fresh persona-scoped copy, so the post shares
 * no object with the persona's other images and deleting it deletes only
 * its own. Edits never alert.
 */
@Injectable()
export class SubprofilePostsService {
  private readonly logger = new Logger(SubprofilePostsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SubprofilePost)
    private readonly posts: Repository<SubprofilePost>,
    private readonly publicRead: SubprofilePublicReadService,
    private readonly personaImageKeys: PersonaImageKeysService,
    private readonly alerts: PersonaPostAlertsService,
  ) {}

  async listPosts(
    viewer: CurrentUserData | undefined,
    subprofileId: string,
    cursor?: string,
  ): Promise<PersonaPostPage> {
    const { persona, isOwner } = await this.publicRead.resolveReadablePersona(
      subprofileId,
      viewer,
    );
    if (!isPersonaPostKind(persona.kind)) {
      return EMPTY_PERSONA_POST_PAGE;
    }
    const pageSize = PERSONA_POST.pageSize;
    const queryBuilder = this.posts
      .createQueryBuilder('post')
      .where('"post"."subprofile_id" = :subprofileId', {
        subprofileId: persona.id,
      });
    const decodedCursor = decodePersonaPostCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("post"."created_at", "post"."id") < (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: decodedCursor.createdAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('post.createdAt', 'DESC')
      .addOrderBy('post.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastPost = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map((post) => toPersonaPost(post, isOwner)),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastPost
            ? encodePersonaPostCursor({
                createdAt: lastPost.createdAt,
                id: lastPost.id,
              })
            : null,
      },
    };
  }

  async createPost(
    userId: string,
    subprofileId: string,
    body: CreatePersonaPostDto,
  ): Promise<PersonaPost> {
    const created = await this.dataSource.transaction(async (manager) => {
      const persona = await manager.findOne(Subprofile, {
        where: { id: subprofileId },
        lock: { mode: 'for_no_key_update' },
      });
      if (
        !persona ||
        persona.removedAt ||
        !(await manager.exists(SubprofileMember, {
          where: { subprofileId: persona.id, userId },
        }))
      ) {
        throw new NotFoundException('Persona not found');
      }
      if (!isPersonaPostKind(persona.kind)) {
        throw personaPostError('persona_posts_not_available');
      }
      const windowStart = new Date(
        Date.now() - PERSONA_POST_QUOTA_WINDOW_MILLISECONDS,
      );
      const postsToday = await manager.count(SubprofilePostQuotaEntry, {
        where: { subprofileId: persona.id, createdAt: MoreThan(windowStart) },
      });
      if (postsToday >= PERSONA_POST.dailyLimit) {
        throw personaPostError('persona_post_daily_limit');
      }
      const imageKey = await this.resolveImageKey(
        manager,
        userId,
        persona.id,
        body.imageKey,
        null,
      );
      const post = await manager.save(
        manager.create(SubprofilePost, {
          subprofileId: persona.id,
          authorUserId: userId,
          body: body.body,
          linkUrl: body.linkUrl || null,
          imageKey,
          editedAt: null,
        }),
      );
      await manager.insert(SubprofilePostQuotaEntry, {
        subprofileId: persona.id,
      });
      await manager.delete(SubprofilePostQuotaEntry, {
        subprofileId: persona.id,
        createdAt: LessThan(windowStart),
      });
      return {
        post,
        persona,
        shouldAlert: postsToday < PERSONA_POST.alertsPerDay,
      };
    });
    if (created.shouldAlert) {
      // Post-commit and best-effort: `alertFollowers` never throws.
      await this.alerts.alertFollowers(created.persona, created.post);
    }
    return toPersonaPost(created.post, true);
  }

  async updatePost(
    userId: string,
    postId: string,
    body: UpdatePersonaPostDto,
  ): Promise<PersonaPost> {
    const { post, discardedImageKey } = await this.dataSource.transaction(
      async (manager) => {
        const lockedPost = await this.lockEditablePost(manager, userId, postId);
        const persona = await manager.findOne(Subprofile, {
          where: { id: lockedPost.subprofileId },
        });
        if (!persona || persona.removedAt) {
          throw new NotFoundException('Persona not found');
        }
        const previousImageKey = lockedPost.imageKey;
        let hasChanges = false;
        if (body.body !== undefined) {
          const nextBody = body.body.trim();
          if (nextBody !== lockedPost.body) {
            lockedPost.body = nextBody;
            hasChanges = true;
          }
        }
        if (body.linkUrl !== undefined) {
          const nextLinkUrl = body.linkUrl || null;
          if (nextLinkUrl !== lockedPost.linkUrl) {
            lockedPost.linkUrl = nextLinkUrl;
            hasChanges = true;
          }
        }
        // An omitted `imageKey` keeps the stored photo (the wire never
        // carries the key, so clients keep a photo by leaving the field out).
        if (body.imageKey !== undefined) {
          lockedPost.imageKey = await this.resolveImageKey(
            manager,
            userId,
            lockedPost.subprofileId,
            body.imageKey,
            previousImageKey,
          );
          if (lockedPost.imageKey !== previousImageKey) {
            hasChanges = true;
          }
        }
        // A PATCH that changes nothing writes nothing and keeps `editedAt`.
        if (!hasChanges) {
          return { post: lockedPost, discardedImageKey: null };
        }
        lockedPost.editedAt = new Date();
        const saved = await manager.save(lockedPost);
        return {
          post: saved,
          discardedImageKey:
            previousImageKey && previousImageKey !== saved.imageKey
              ? previousImageKey
              : null,
        };
      },
    );
    if (discardedImageKey) {
      await this.discardImage(discardedImageKey);
    }
    return toPersonaPost(post, true);
  }

  async deletePost(userId: string, postId: string): Promise<void> {
    const imageKey = await this.dataSource.transaction(async (manager) => {
      const lockedPost = await this.lockEditablePost(manager, userId, postId);
      await manager.delete(SubprofilePost, { id: lockedPost.id });
      return lockedPost.imageKey;
    });
    // The follower bells stay: they age out, and a bundled bell may already
    // show a newer post. Staff removal is the path that deletes bells.
    if (imageKey) {
      await this.discardImage(imageKey);
    }
  }

  // The post locked for the write, when the caller owns or co-owns its
  // persona. Everyone else, and a missing post, gets the same 404.
  private async lockEditablePost(
    manager: EntityManager,
    userId: string,
    postId: string,
  ): Promise<SubprofilePost> {
    const post = await manager.findOne(SubprofilePost, {
      where: { id: postId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !post ||
      !(await manager.exists(SubprofileMember, {
        where: { subprofileId: post.subprofileId, userId },
      }))
    ) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  /**
   * The photo key a post should store. `undefined` keeps the stored one,
   * null or an empty string clears, the stored key sent back stays, and
   * anything else must be an image the caller uploaded or a persona-scoped
   * image of this persona, copied to a fresh key of this persona.
   */
  private async resolveImageKey(
    manager: EntityManager,
    userId: string,
    subprofileId: string,
    imageKey: string | null | undefined,
    storedKey: string | null,
  ): Promise<string | null> {
    if (imageKey === undefined) {
      return storedKey;
    }
    if (!imageKey) {
      return null;
    }
    if (imageKey === storedKey) {
      return storedKey;
    }
    if (!isUsablePostImageKey(imageKey)) {
      throw personaPostError('persona_post_image_not_allowed');
    }
    if (isPersonaScopedKey(imageKey)) {
      const registration =
        await this.personaImageKeys.findRegistration(imageKey);
      if (registration?.subprofileId !== subprofileId) {
        throw personaPostError('persona_post_image_not_allowed');
      }
    } else if (storageKeyOwnerId(imageKey) !== userId) {
      throw personaPostError('persona_post_image_not_allowed');
    }
    const rehomed = await this.personaImageKeys.rehomeKeys(
      manager,
      subprofileId,
      [imageKey],
      { shouldCopyMemberScoped: true, personaScopedMode: 'copy-all' },
    );
    const freshKey = rehomed.get(imageKey) ?? null;
    if (!freshKey) {
      throw personaPostError('persona_post_image_not_allowed');
    }
    return freshKey;
  }

  // After the commit: the object is the post's own copy, so nothing else
  // shows it. Its registry row goes first so `GET /files/*` stops serving
  // it at once.
  private async discardImage(imageKey: string): Promise<void> {
    try {
      await this.personaImageKeys.forgetDeletedKeys([imageKey]);
      await this.personaImageKeys.deleteObjects([imageKey]);
    } catch (error) {
      this.logger.warn(
        `Persona post photo ${imageKey} was not deleted: ${String(error)}`,
      );
    }
  }
}
