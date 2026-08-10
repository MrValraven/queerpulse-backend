import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import {
  toArticleCommentResponse,
  toArticleCommentTree,
  UNRESOLVED_COMMENT_AUTHOR_LABEL,
} from './magazine-article-comment-response';

function makeComment(
  overrides: Partial<MagazineArticleComment> = {},
): MagazineArticleComment {
  return {
    id: 'comment-1',
    articleId: 'article-1',
    blockId: null,
    parentId: null,
    authorId: 'user-1',
    body: 'Nice lede.',
    resolved: false,
    createdAt: new Date('2026-08-10T09:00:00Z'),
    ...overrides,
  };
}

describe('toArticleCommentTree', () => {
  it('nests replies under their parent, top-level newest-first, replies oldest-first', () => {
    const topA = makeComment({
      id: 'top-a',
      createdAt: new Date('2026-08-09T09:00:00Z'),
    });
    const topB = makeComment({
      id: 'top-b',
      createdAt: new Date('2026-08-10T09:00:00Z'),
    });
    const replyOld = makeComment({
      id: 'reply-old',
      parentId: 'top-a',
      createdAt: new Date('2026-08-09T10:00:00Z'),
    });
    const replyNew = makeComment({
      id: 'reply-new',
      parentId: 'top-a',
      createdAt: new Date('2026-08-09T11:00:00Z'),
    });

    // Deliberately out of order (replies before their parent, newest reply
    // before oldest) so the mapper's own sorting is what's under test.
    const tree = toArticleCommentTree(
      [topA, topB, replyNew, replyOld],
      new Map([['user-1', 'Ana Silva']]),
    );

    expect(tree.map((comment) => comment.id)).toEqual(['top-b', 'top-a']);
    expect(tree[1]?.replies.map((reply) => reply.id)).toEqual([
      'reply-old',
      'reply-new',
    ]);
    expect(tree[0]?.replies).toEqual([]);
  });

  it("resolves each comment's author name from the passed map, never the raw id or an email", () => {
    const comment = makeComment({ authorId: 'user-42' });

    const [resolved] = toArticleCommentTree(
      [comment],
      new Map([['user-42', 'Kai Duarte']]),
    );

    expect(resolved?.author).toBe('Kai Duarte');
    expect(resolved?.author).not.toContain('user-42');
    expect(resolved?.author).not.toContain('@');
  });

  it('falls back to a neutral label when the author id is missing from the map', () => {
    const comment = makeComment({ authorId: 'ghost-1' });

    const [resolved] = toArticleCommentTree([comment], new Map());

    expect(resolved?.author).toBe(UNRESOLVED_COMMENT_AUTHOR_LABEL);
    expect(resolved?.author).not.toContain('ghost-1');
  });

  it('round-trips the resolved flag for both top-level comments and replies', () => {
    const resolvedTop = makeComment({ id: 'top-resolved', resolved: true });
    const openTop = makeComment({ id: 'top-open', resolved: false });
    const resolvedReply = makeComment({
      id: 'reply-resolved',
      parentId: 'top-resolved',
      resolved: true,
    });

    const tree = toArticleCommentTree(
      [resolvedTop, openTop, resolvedReply],
      new Map([['user-1', 'Ana Silva']]),
    );

    const foundResolvedTop = tree.find((c) => c.id === 'top-resolved');
    const foundOpenTop = tree.find((c) => c.id === 'top-open');
    expect(foundResolvedTop?.resolved).toBe(true);
    expect(foundOpenTop?.resolved).toBe(false);
    expect(foundResolvedTop?.replies[0]?.resolved).toBe(true);
  });
});

describe('toArticleCommentResponse', () => {
  it('maps a single comment with no replies attached', () => {
    const comment = makeComment({ resolved: true, blockId: 'block-1' });

    const result = toArticleCommentResponse(comment, 'Ana Silva');

    expect(result).toEqual({
      id: 'comment-1',
      blockId: 'block-1',
      parentId: null,
      author: 'Ana Silva',
      body: 'Nice lede.',
      resolved: true,
      createdAt: '2026-08-10T09:00:00.000Z',
      replies: [],
    });
  });
});
