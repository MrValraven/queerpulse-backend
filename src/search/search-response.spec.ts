import { topicToResult } from './search-response';

describe('topicToResult', () => {
  it('carries the post count as a number so the client can phrase it in the member language (PRD-327)', () => {
    const result = topicToResult({ tag: 'pride', totalPosts: 347 });

    expect(result).toEqual({
      type: 'topic',
      slug: 'pride',
      name: '#pride',
      sub: '347 posts',
      postCount: 347,
    });
  });

  it('keeps a zero count as a number', () => {
    const result = topicToResult({ tag: 'quiet', totalPosts: 0 });

    expect(result.postCount).toBe(0);
    expect(result.sub).toBe('0 posts');
  });
});
