import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { PERSONA_POST_AUDIT_ACTIONS } from './persona-post.constants';
import { deletePersonaPostNotifications } from './subprofile-posts.service';

/** The report detail's view of a reported post. Names the persona only. */
export interface AdminPersonaPost {
  id: string;
  body: string;
  linkUrl: string | null;
  imageUrl: string | null;
  createdAt: string;
  editedAt: string | null;
  persona: { id: string; name: string; handle: string | null };
}

/**
 * Studio v3: staff read and remove a reported persona post. Removal deletes
 * the post and writes a `mod_audit_logs` row in the same transaction (no
 * target member: the post belongs to a persona, and the member drawer must
 * never tie a pseudonymous persona to its owner), then deletes its follower
 * bells and its photo. A removal made from a report carries the report id,
 * so the audit row shows up in that report's trail; that report must exist,
 * be a `persona_post` report and name this post, checked in the same
 * transaction, or the removal answers 404 `Report not found` and writes
 * nothing.
 */
@Injectable()
export class SubprofilePostModerationService {
  private readonly logger = new Logger(SubprofilePostModerationService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SubprofilePost)
    private readonly posts: Repository<SubprofilePost>,
    private readonly modAudit: ModAuditService,
    private readonly personaImageKeys: PersonaImageKeysService,
  ) {}

  async getForStaff(postId: string): Promise<AdminPersonaPost> {
    const post = await this.posts.findOne({
      where: { id: postId },
      relations: { subprofile: true },
    });
    if (!post?.subprofile) {
      throw new NotFoundException('Post not found');
    }
    return {
      id: post.id,
      body: post.body,
      linkUrl: post.linkUrl,
      imageUrl: toImageUrl(post.imageKey),
      createdAt: post.createdAt.toISOString(),
      editedAt: post.editedAt ? post.editedAt.toISOString() : null,
      persona: {
        id: post.subprofile.id,
        name: post.subprofile.displayName,
        handle: post.subprofile.handle,
      },
    };
  }

  async removePost(
    actorId: string,
    postId: string,
    reason: string,
    reportId?: string,
  ): Promise<void> {
    const imageKey = await this.dataSource.transaction(async (manager) => {
      const post = await manager.findOne(SubprofilePost, {
        where: { id: postId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!post) {
        throw new NotFoundException('Post not found');
      }
      if (reportId) {
        const report = await manager.findOne(Report, {
          where: { id: reportId },
        });
        // The subject id compares case-blind, as the Studio takedown does:
        // a report can hold the uuid in any letter case.
        if (
          !report ||
          report.subjectType !== ReportSubjectType.PersonaPost ||
          report.subjectId.toLowerCase() !== post.id.toLowerCase()
        ) {
          throw new NotFoundException('Report not found');
        }
      }
      await manager.delete(SubprofilePost, { id: post.id });
      await this.modAudit.writeAuditLog(
        reportId ?? null,
        actorId,
        PERSONA_POST_AUDIT_ACTIONS.removed,
        undefined,
        `${post.id}: ${reason}`,
        undefined,
        manager,
        null,
      );
      return post.imageKey;
    });
    await deletePersonaPostNotifications(this.dataSource, this.logger, postId);
    if (!imageKey) {
      return;
    }
    try {
      await this.personaImageKeys.forgetDeletedKeys([imageKey]);
      await this.personaImageKeys.deleteObjects([imageKey]);
    } catch (error) {
      this.logger.warn(
        `Removed post photo ${imageKey} was not deleted: ${String(error)}`,
      );
    }
  }
}
