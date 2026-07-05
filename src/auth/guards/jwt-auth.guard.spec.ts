import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

function ctx(type: 'http' | 'ws'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    guard = new JwtAuthGuard(reflector as unknown as Reflector);
  });

  it('lets non-http (websocket) contexts through without checking metadata', () => {
    expect(guard.canActivate(ctx('ws'))).toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it('lets @Public() http routes through without authenticating', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(ctx('http'))).toBe(true);
  });

  it('delegates to passport for a protected http route', () => {
    const superProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
    const spy = jest
      .spyOn(superProto, 'canActivate')
      .mockReturnValue('DELEGATED');
    try {
      expect(guard.canActivate(ctx('http'))).toBe('DELEGATED');
    } finally {
      spy.mockRestore();
    }
  });
});
