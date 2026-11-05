import { HttpMetricsMiddleware } from './http-metrics.middleware';

describe('HttpMetricsMiddleware', () => {
  it('skips a creator draft request and observes everything else', () => {
    const metrics = { observeHttpRequest: jest.fn() };
    const middleware = new HttpMetricsMiddleware(metrics as never);
    const next = jest.fn();
    const listeners: Record<string, () => void> = {};
    const response = {
      statusCode: 200,
      on: (name: string, listener: () => void) => {
        listeners[name] = listener;
      },
    };
    middleware.use(
      {
        originalUrl: '/v1/admin/creator-drafts?kind=event',
        method: 'GET',
      } as never,
      response as never,
      next,
    );
    expect(listeners.finish).toBeUndefined();
    middleware.use(
      {
        originalUrl: '/v1/events',
        method: 'GET',
        route: { path: '/events' },
        baseUrl: '/v1',
      } as never,
      response as never,
      next,
    );
    expect(listeners.finish).toBeDefined();
    listeners.finish?.();
    expect(metrics.observeHttpRequest).toHaveBeenCalledWith(
      'GET',
      '/v1/events',
      200,
      expect.any(Number),
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('skips a leads request', () => {
    const metrics = { observeHttpRequest: jest.fn() };
    const middleware = new HttpMetricsMiddleware(metrics as never);
    const next = jest.fn();
    const listeners: Record<string, () => void> = {};
    const response = {
      statusCode: 200,
      on: (name: string, listener: () => void) => {
        listeners[name] = listener;
      },
    };
    middleware.use(
      { originalUrl: '/v1/admin/leads?q=ana', method: 'GET' } as never,
      response as never,
      next,
    );
    expect(listeners.finish).toBeUndefined();
    expect(metrics.observeHttpRequest).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips a VJ request', () => {
    const metrics = { observeHttpRequest: jest.fn() };
    const middleware = new HttpMetricsMiddleware(metrics as never);
    const next = jest.fn();
    const listeners: Record<string, () => void> = {};
    const response = {
      statusCode: 200,
      on: (name: string, listener: () => void) => {
        listeners[name] = listener;
      },
    };
    middleware.use(
      { originalUrl: '/v1/admin/vj/packs', method: 'GET' } as never,
      response as never,
      next,
    );
    expect(listeners.finish).toBeUndefined();
    expect(metrics.observeHttpRequest).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
