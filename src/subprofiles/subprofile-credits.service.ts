import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileItemInputDTO } from './dto/replace-items.dto';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { CollaboratorView } from './subprofile-response';
import { SubprofilePublicReadService } from './subprofile-public-read.service';

// The collaboration-credit side effect of a section save (Personas discovery
// Phase 5, Moment 6): computing WHICH `@handle`-credited members are NEWLY
// credited by a `replaceSection` write, and notifying them post-commit.
// Extracted from the former god-service — the write/orchestration of
// `replaceSection` stays on `SubprofilesService`, which calls into this
// service for the diff (before the write) and the fan-out (after it commits).
@Injectable()
export class SubprofileCreditsService {
  constructor(
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Handle)
    private readonly handleRegistry: Repository<Handle>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
    private readonly publicRead: SubprofilePublicReadService,
  ) {}

  // `subprofile_credit` diff (Personas discovery Phase 5, Decision §3):
  // `replaceSection` deletes-and-recreates ONE section per save with no
  // stable item ids across saves, so a naive "notify anyone credited on
  // this save" hook would re-fire on every unrelated edit to a section
  // that still happens to list the same collaborator. Instead: snapshot
  // the PERSONA-WIDE (every section, not just this one) resolved-member
  // collaborator set BEFORE this write, compare it to the persona-wide set
  // AFTER, and only notify handles that are newly present. Scoping the
  // diff to the whole persona (not just this section) matters: a handle
  // already credited in an untouched OTHER section must never look "new"
  // just because this section's payload happens to add it too.
  //
  // `incomingResolvedByHandle` is THIS section's already-resolved incoming
  // collaborators (the map `replaceSection` computed for its own validation),
  // reused here so the AFTER set costs no extra `resolveHandles` call.
  async computeNewlyCreditedHandles(
    subprofileId: string,
    ownerId: string,
    sectionEnum: SubprofileSection,
    incomingResolvedByHandle: Map<string, CollaboratorView>,
  ): Promise<string[]> {
    const existingItems = await this.items.find({
      where: { subprofileId },
    });
    const existingHandlesResolved = await this.publicRead.resolveHandles(
      existingItems.flatMap((item) => item.collaborators ?? []),
      ownerId,
    );
    const beforeMemberHandles = new Set(
      [...existingHandlesResolved.entries()]
        .filter(([, view]) => view.type === 'member')
        .map(([handle]) => handle),
    );
    // AFTER = this section's newly-resolved handles (`incomingResolvedByHandle`,
    // already computed by the caller for validation) UNION every OTHER
    // section's existing handles — whose resolution already lives in
    // `existingHandlesResolved`, so no extra `resolveHandles` call is needed.
    const afterMemberHandles = new Set(
      existingItems
        .filter((item) => item.section !== sectionEnum)
        .flatMap((item) => item.collaborators ?? [])
        .filter(
          (handle) => existingHandlesResolved.get(handle)?.type === 'member',
        ),
    );
    for (const [handle, view] of incomingResolvedByHandle) {
      if (view.type === 'member') {
        afterMemberHandles.add(handle);
      }
    }
    // Every handle here is necessarily one of THIS section's incoming
    // handles: any handle already credited in an untouched other section was
    // already folded into `beforeMemberHandles` above, so it can never
    // survive this subtraction.
    return [...afterMemberHandles].filter(
      (handle) => !beforeMemberHandles.has(handle),
    );
  }

  // Notifies each newly-credited handle's member (Personas discovery Phase 5,
  // Moment 6), excluding: handles that don't resolve to a real member's
  // userId, and the persona's own owner/co-owners (crediting yourself/a
  // fellow co-owner never notifies). Block/mute is honoured via
  // `notifications.create`'s `actorId` filter, passing the crediting
  // persona's owner — the same safety gate every other member-driven
  // notification in this codebase uses.
  async emitSubprofileCreditNotifications(
    sp: Subprofile,
    subprofileId: string,
    newlyCreditedHandles: string[],
    items: SubprofileItemInputDTO[],
    normalizedCollaboratorsByItemIndex: string[][],
  ): Promise<void> {
    const memberUserIdByHandle =
      await this.resolveMemberUserIdsByHandle(newlyCreditedHandles);
    if (!memberUserIdByHandle.size) return;
    const ownerAndCoOwnerIds = new Set(
      (
        await this.members.find({
          where: { subprofileId },
          select: { userId: true },
        })
      ).map((member) => member.userId),
    );
    const deepLink = await this.buildPersonaDeepLink(sp);
    for (const handle of newlyCreditedHandles) {
      const memberUserId = memberUserIdByHandle.get(handle);
      if (!memberUserId || ownerAndCoOwnerIds.has(memberUserId)) {
        continue; // unresolvable, or crediting yourself/a fellow co-owner
      }
      const creditingItem = items.find((_, index) =>
        normalizedCollaboratorsByItemIndex[index]?.includes(handle),
      );
      const itemTitle = creditingItem ? creditingItem.title : sp.displayName;
      await this.notifications.create(
        memberUserId,
        NotificationType.SubprofileCredit,
        {
          subprofileName: sp.displayName,
          subprofileSlugOrHandle: sp.handle ?? sp.slug,
          itemTitle,
          deepLink,
        },
        sp.userId,
      );
    }
  }

  // Resolves ONLY the member-owned handles among `handleNames` to their
  // `userId` (never a persona handle's owner) — a separate, narrow query from
  // `resolveHandles` on purpose: `CollaboratorView` (the client-facing shape
  // `resolveHandles` returns) never carries a `userId`, and it must not start
  // to, so a persona's public item payload can never leak one. Unfiltered by
  // block/mute — callers that need that filtering already got it from
  // `resolveHandles` before landing here (a handle only reaches this method
  // once it is already known to be a genuinely NEW, resolved-member credit).
  private async resolveMemberUserIdsByHandle(
    handleNames: string[],
  ): Promise<Map<string, string>> {
    const userIdByHandle = new Map<string, string>();
    if (!handleNames.length) return userIdByHandle;
    const handleRows = await this.handleRegistry.find({
      where: { name: In(handleNames), ownerKind: HandleOwnerKind.Profile },
    });
    for (const row of handleRows) {
      if (row.userId) {
        userIdByHandle.set(row.name, row.userId);
      }
    }
    return userIdByHandle;
  }

  // The persona's own page, for a `subprofile_credit` notification's
  // deep link. Unlinked + published (a claimed global handle) → its
  // standalone `/p/:handle` page. Otherwise (linked, or unlinked but not yet
  // published) → the nested `/members/:ownerSlug/:slug` shape, resolving the
  // owner's profile slug once — a persona credited before it's ever
  // published is an edge case the link degrades gracefully for rather than
  // 500ing, at the cost of not being a live route until the owner publishes.
  private async buildPersonaDeepLink(sp: Subprofile): Promise<string> {
    if (sp.linkVisibility === SubprofileLinkVisibility.Unlinked && sp.handle) {
      return `/p/${sp.handle}`;
    }
    const ownerProfile = await this.profiles.findOne({
      where: { userId: sp.userId },
    });
    return ownerProfile
      ? `/members/${ownerProfile.slug}/${sp.slug}`
      : '/account/subprofiles';
  }
}
