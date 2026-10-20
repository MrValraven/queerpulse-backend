import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { MEMBER_BLOCKED, MemberBlockedEvent } from '../social/social.events';
import { endEditingBetweenMembers } from './studio-playlist-editor-endings';

/**
 * Collaborative playlists. A block between two members ends every editor
 * seat one holds on a playlist the other owns, in either direction: an
 * invitation becomes `revoked`, an active seat becomes `revoked`, and the
 * entries the ended editor added lose their "added by". The tracks stay.
 *
 * No bell goes out: telling either member would disclose the block.
 *
 * Best effort, as every `MEMBER_BLOCKED` consumer is (the event fires
 * post-commit). The role read in `lockPlaylistFor` and the editor row read
 * in `StudioPlaylistReadsService` refuse a blocked pair on their own, so a
 * failure here leaves a stale row that grants nothing.
 */
@Injectable()
export class StudioPlaylistEditorBlockListener {
  private readonly logger = new Logger(StudioPlaylistEditorBlockListener.name);

  constructor(private readonly dataSource: DataSource) {}

  @OnEvent(MEMBER_BLOCKED, { async: true })
  async handleMemberBlocked(event: MemberBlockedEvent): Promise<void> {
    const { blockerId, blockedId } = event;
    if (!blockerId || !blockedId || blockerId === blockedId) {
      return;
    }
    try {
      await endEditingBetweenMembers(
        this.dataSource.manager,
        blockerId,
        blockedId,
      );
    } catch (error) {
      this.logger.warn(
        `Ending playlist editing after a block failed: ${String(error)}`,
      );
    }
  }
}
