import {
  dropQuizshowRequestBody,
  isQuizshowRequestUrl,
  redactQuizshowJoinCodePath,
  redactQuizshowJoinCodeReferer,
} from './quizshow-request-log';

describe('isQuizshowRequestUrl', () => {
  it('matches the quiz, import, sessions and results routes', () => {
    expect(isQuizshowRequestUrl('/events/quiz-da-lua/quizshow')).toBe(true);
    expect(isQuizshowRequestUrl('/v1/events/x/quizshow/import')).toBe(true);
    expect(isQuizshowRequestUrl('/events/x/quizshow/sessions')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/join')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/templates?x=1')).toBe(true);
  });

  it('treats the game routes as Pulse Live', () => {
    expect(isQuizshowRequestUrl('/v1/quizshow/games/abc/import')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/games')).toBe(true);
    expect(isQuizshowRequestUrl('/admin/quizshow/sessions/x/end')).toBe(false);
  });

  it('treats the staff template routes as Pulse Live', () => {
    expect(isQuizshowRequestUrl('/v1/admin/quizshow/templates/abc')).toBe(true);
    expect(isQuizshowRequestUrl('/admin/quizshow/templates')).toBe(true);
    expect(isQuizshowRequestUrl('/admin/quizshow/sessions/x/end')).toBe(false);
  });

  it('leaves other event routes alone', () => {
    expect(isQuizshowRequestUrl('/events/x')).toBe(false);
    expect(isQuizshowRequestUrl('/events/quizshow-night')).toBe(false);
    expect(isQuizshowRequestUrl('/events/x/photos')).toBe(false);
    expect(isQuizshowRequestUrl(undefined)).toBe(false);
  });
});

describe('dropQuizshowRequestBody', () => {
  it('removes the body of a Pulse Live route', () => {
    const request = { url: '/quizshow/join', data: '{"code":"ABCD"}' };
    dropQuizshowRequestBody(request);
    expect(request.data).toBeUndefined();
  });

  it('keeps the body of other routes', () => {
    const request = { url: '/events/x', data: 'body' };
    dropQuizshowRequestBody(request);
    expect(request.data).toBe('body');
  });
});

describe('redactQuizshowJoinCodePath', () => {
  it('replaces the join code of a preview path and keeps the query string', () => {
    expect(redactQuizshowJoinCodePath('/quizshow/join-preview/QZ4KM7')).toBe(
      '/quizshow/join-preview/[code]',
    );
    expect(
      redactQuizshowJoinCodePath('/v1/quizshow/join-preview/qz4-km7?x=1'),
    ).toBe('/v1/quizshow/join-preview/[code]?x=1');
    expect(
      redactQuizshowJoinCodePath(
        'https://api.example.test/v1/quizshow/join-preview/QZ4KM7#top',
      ),
    ).toBe('https://api.example.test/v1/quizshow/join-preview/[code]#top');
  });

  it('leaves every other URL untouched', () => {
    for (const url of [
      '/quizshow/join',
      '/quizshow/join-preview',
      '/quizshow/device-pairings/e0400000-0000-4000-8000-000000000001/claim',
      '/events/x/quizshow/sessions/refresh',
      '/events/x',
    ]) {
      expect(redactQuizshowJoinCodePath(url)).toBe(url);
    }
    expect(redactQuizshowJoinCodePath(undefined)).toBeUndefined();
  });
});

describe('dropQuizshowRequestBody on the device and preview routes', () => {
  it('redacts the join code of a preview request', () => {
    const request: { url?: string; data?: unknown } = {
      url: 'https://api.example.test/v1/quizshow/join-preview/QZ4KM7?lang=pt',
    };
    dropQuizshowRequestBody(request);
    expect(request.url).toBe(
      'https://api.example.test/v1/quizshow/join-preview/[code]?lang=pt',
    );
  });

  it('drops the claim body that holds the poll token and keeps its URL', () => {
    const url =
      '/v1/quizshow/device-pairings/e0400000-0000-4000-8000-000000000001/claim';
    const request = { url, data: `{"pollToken":"${'a'.repeat(43)}"}` };
    dropQuizshowRequestBody(request);
    expect(request.data).toBeUndefined();
    expect(request.url).toBe(url);
  });

  it('keeps the URL of other Pulse Live routes and of other routes', () => {
    const quizshowRequest = { url: '/quizshow/join', data: 'body' };
    dropQuizshowRequestBody(quizshowRequest);
    expect(quizshowRequest.url).toBe('/quizshow/join');
    const otherRequest = { url: '/events/x/join-preview/QZ4KM7', data: 'body' };
    dropQuizshowRequestBody(otherRequest);
    expect(otherRequest).toEqual({
      url: '/events/x/join-preview/QZ4KM7',
      data: 'body',
    });
  });
});

describe('redactQuizshowJoinCodeReferer', () => {
  it('replaces the join code of the frontend join page and of the preview path', () => {
    expect(
      redactQuizshowJoinCodeReferer('https://queerpulse.test/play/QZ4KM7'),
    ).toBe('https://queerpulse.test/play/[code]');
    expect(
      redactQuizshowJoinCodeReferer(
        'https://queerpulse.test/play/qz4-km7/lobby?x=1',
      ),
    ).toBe('https://queerpulse.test/play/[code]/lobby?x=1');
    expect(redactQuizshowJoinCodeReferer('/play/QZ4KM7#top')).toBe(
      '/play/[code]#top',
    );
    expect(
      redactQuizshowJoinCodeReferer(
        'https://api.queerpulse.test/v1/quizshow/join-preview/QZ4KM7',
      ),
    ).toBe('https://api.queerpulse.test/v1/quizshow/join-preview/[code]');
  });

  it('keeps the fixed pages under /play and every other URL', () => {
    for (const url of [
      'https://queerpulse.test/play',
      'https://queerpulse.test/play/',
      'https://queerpulse.test/play/tv',
      'https://queerpulse.test/play/TV?x=1',
      'https://queerpulse.test/play/remote/e0100000-0000-4000-8000-000000000001',
      'https://queerpulse.test/play/games',
      'https://queerpulse.test/play/games/e0200000-0000-4000-8000-000000000001',
      'https://queerpulse.test/events/x/play/QZ4KM7',
      'https://queerpulse.test/feed',
    ]) {
      expect(redactQuizshowJoinCodeReferer(url)).toBe(url);
    }
  });
});
