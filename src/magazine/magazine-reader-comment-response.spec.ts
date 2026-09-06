import { MemberRef } from '../common/member-ref';
import { MagazineReaderComment } from './entities/magazine-reader-comment.entity';
import { toReaderCommentResponse } from './magazine-reader-comment-response';

const AUTHOR: MemberRef = {
  slug: 'ana',
  firstName: 'Ana',
  lastName: 'Lopes',
  pronouns: null,
  avatarUrl: null,
};

function comment(
  overrides: Partial<MagazineReaderComment> = {},
): MagazineReaderComment {
  return {
    id: 'c1',
    articleId: 'article-1',
    parentId: null,
    authorId: 'author-1',
    body: 'Great piece.',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('toReaderCommentResponse', () => {
  it('maps a live comment with its author, and lets the author edit and delete it', () => {
    const response = toReaderCommentResponse(comment(), AUTHOR, 'author-1', {
      hidden: false,
      removed: false,
    });

    expect(response.body).toBe('Great piece.');
    expect(response.author).toEqual({
      handle: 'ana',
      displayName: 'Ana Lopes',
      avatarUrl: null,
    });
    expect(response.deleted).toBe(false);
    expect(response.canEdit).toBe(true);
    expect(response.canDelete).toBe(true);
  });

  it('gives a non-author no edit or delete affordance', () => {
    const response = toReaderCommentResponse(
      comment(),
      AUTHOR,
      'someone-else',
      {
        hidden: false,
        removed: false,
      },
    );

    expect(response.canEdit).toBe(false);
    expect(response.canDelete).toBe(false);
  });

  it('tombstones an author-deleted comment', () => {
    const response = toReaderCommentResponse(
      comment({ deletedAt: new Date('2026-01-03T00:00:00.000Z') }),
      AUTHOR,
      'author-1',
      { hidden: false, removed: false },
    );

    expect(response.deleted).toBe(true);
    expect(response.body).toBe('');
    expect(response.author.displayName).toBe('');
    expect(response.canEdit).toBe(false);
    expect(response.canDelete).toBe(false);
  });

  it('tombstones a moderation-removed comment', () => {
    const response = toReaderCommentResponse(comment(), AUTHOR, 'author-1', {
      hidden: false,
      removed: true,
    });

    expect(response.deleted).toBe(true);
    expect(response.body).toBe('');
  });

  it('tombstones a moderation-HIDDEN comment: blanked and deleted stay in lockstep', () => {
    const response = toReaderCommentResponse(comment(), AUTHOR, 'author-1', {
      hidden: true,
      removed: false,
    });

    // The regression this guards: `deleted` used to stay false while the body
    // and author were blanked, so the frontend skipped its tombstone branch
    // and rendered an empty card with live Reply and Report buttons.
    expect(response.deleted).toBe(true);
    expect(response.body).toBe('');
    expect(response.author.displayName).toBe('');
    expect(response.canEdit).toBe(false);
    expect(response.canDelete).toBe(false);
  });

  it('keeps replies on the response it is handed', () => {
    const reply = toReaderCommentResponse(
      comment({ id: 'r1', parentId: 'c1' }),
      AUTHOR,
      'author-1',
      { hidden: false, removed: false },
    );
    const response = toReaderCommentResponse(
      comment(),
      AUTHOR,
      'author-1',
      { hidden: false, removed: false },
      [reply],
    );

    expect(response.replies).toEqual([reply]);
  });
});
