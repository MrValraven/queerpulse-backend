import { CommunityPost, PostKind } from './entities/community-post.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { RosterRole } from './entities/community-member.entity';
import { toCommunityPost, toCommunityReply } from './community-response';

function makePost(overrides: Partial<CommunityPost> = {}): CommunityPost {
  return {
    id: 'post-1',
    communityId: 'community-1',
    authorId: 'author-1',
    body: 'hello',
    image: null,
    kind: PostKind.Post,
    pinned: false,
    createdAt: new Date('2026-07-23T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeReply(
  overrides: Partial<CommunityPostReply> = {},
): CommunityPostReply {
  return {
    id: 'reply-1',
    postId: 'post-1',
    authorId: 'author-1',
    text: 'hi there',
    createdAt: new Date('2026-07-23T10:05:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('toCommunityPost / toCommunityReply permission flags', () => {
  it('author can edit + delete their own live post', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      [],
      [],
      'author-1',
      RosterRole.Member,
    );
    expect(dto.canEdit).toBe(true);
    expect(dto.canDelete).toBe(true);
    expect(dto.canRestore).toBe(false);
  });

  it('owner/mod can delete but NOT edit another member post', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      [],
      [],
      'mod-1',
      RosterRole.Mod,
    );
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(true);
  });

  it('a plain member (non-author) can do nothing', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      [],
      [],
      'other-1',
      RosterRole.Member,
    );
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(false);
    expect(dto.canRestore).toBe(false);
    expect(dto.canViewHistory).toBe(false);
  });

  it('a non-member viewer can do nothing', () => {
    const dto = toCommunityPost(makePost(), null, [], [], 'nobody', null);
    expect(dto.canDelete).toBe(false);
  });

  it('an ex-member author (left the community) can no longer edit or delete', () => {
    const dto = toCommunityPost(makePost(), null, [], [], 'author-1', null);
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(false);
  });

  it('tombstoned post hides body/author and offers restore to owner/mod', () => {
    const dto = toCommunityPost(
      makePost({ deletedAt: new Date() }),
      { slug: 'a', firstName: 'A', lastName: 'B', avatarUrl: null },
      [],
      [],
      'mod-1',
      RosterRole.Owner,
    );
    expect(dto.deleted).toBe(true);
    expect(dto.body).toBe('');
    expect(dto.author?.slug).toBe('');
    expect(dto.canRestore).toBe(true);
    expect(dto.canDelete).toBe(false);
  });

  it('canViewHistory only once edited, for author/owner/mod', () => {
    const edited = makePost({ editedAt: new Date() });
    expect(
      toCommunityPost(edited, null, [], [], 'author-1', RosterRole.Member)
        .canViewHistory,
    ).toBe(true);
    expect(
      toCommunityPost(edited, null, [], [], 'mod-1', RosterRole.Mod)
        .canViewHistory,
    ).toBe(true);
    expect(
      toCommunityPost(edited, null, [], [], 'other-1', RosterRole.Member)
        .canViewHistory,
    ).toBe(false);
    expect(
      toCommunityPost(makePost(), null, [], [], 'author-1', RosterRole.Member)
        .canViewHistory,
    ).toBe(false);
  });

  it('reply flags mirror post flags (edit author-only; delete author-or-owner/mod)', () => {
    const authored = toCommunityReply(
      makeReply(),
      null,
      'author-1',
      RosterRole.Member,
    );
    expect(authored.canEdit).toBe(true);
    expect(authored.canDelete).toBe(true);
    const byMod = toCommunityReply(makeReply(), null, 'mod-1', RosterRole.Mod);
    expect(byMod.canEdit).toBe(false);
    expect(byMod.canDelete).toBe(true);
  });
});
