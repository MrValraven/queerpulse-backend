import {
  dropQuizshowRequestBody,
  isQuizshowRequestUrl,
} from './quizshow-request-log';

describe('isQuizshowRequestUrl', () => {
  it('matches the quiz, import, sessions and results routes', () => {
    expect(isQuizshowRequestUrl('/events/quiz-da-lua/quizshow')).toBe(true);
    expect(isQuizshowRequestUrl('/v1/events/x/quizshow/import')).toBe(true);
    expect(isQuizshowRequestUrl('/events/x/quizshow/sessions')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/join')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/packs?x=1')).toBe(true);
  });

  it('treats the game routes as Pulse Live', () => {
    expect(isQuizshowRequestUrl('/v1/quizshow/games/abc/import')).toBe(true);
    expect(isQuizshowRequestUrl('/quizshow/games')).toBe(true);
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
