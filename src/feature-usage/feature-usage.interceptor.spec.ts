import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { FeatureUsageInterceptor } from './feature-usage.interceptor';
import { FeatureUsageTallyService } from './feature-usage-tally.service';

function contextFor(
  contextType = 'http',
  controllerClass: new () => unknown = class {},
) {
  return {
    getType: () => contextType,
    getHandler: () => () => undefined,
    getClass: () => controllerClass,
  } as unknown as ExecutionContext;
}

describe('FeatureUsageInterceptor', () => {
  let tally: FeatureUsageTallyService;
  let reflector: Reflector;
  let interceptor: FeatureUsageInterceptor;
  const next: CallHandler = { handle: () => of(null) };

  beforeEach(() => {
    tally = new FeatureUsageTallyService();
    reflector = new Reflector();
    interceptor = new FeatureUsageInterceptor(reflector, tally);
  });

  it('records a request against the controller feature key', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('housing');
    interceptor.intercept(contextFor(), next);
    expect(tally.drain().get('housing')).toBe(1);
  });

  it('records nothing for an untagged controller', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    interceptor.intercept(contextFor(), next);
    expect(tally.drain().size).toBe(0);
  });

  it('records nothing outside an http context', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('messaging');
    interceptor.intercept(contextFor('ws'), next);
    expect(tally.drain().size).toBe(0);
  });

  it('drain clears the tally', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('forum');
    interceptor.intercept(contextFor(), next);
    tally.drain();
    expect(tally.drain().size).toBe(0);
  });

  it('restore adds failed tallies back onto what has since accumulated', () => {
    tally.record('forum');
    tally.restore(new Map([['forum', 3]]));
    expect(tally.drain().get('forum')).toBe(4);
  });

  // This repo mandates that guarded admin CRUD gets its own `Admin*Controller`
  // (see CLAUDE.md), so a class name starting with `Admin` reliably identifies
  // a staff surface. Staff requests must not inflate reach: depth deliberately
  // counts only rows a member can create, and counting staff traffic on the
  // reach side would pair a staff-driven reach number against a member-only
  // depth number and misreport the pairing as browsed-but-empty.
  it('records nothing for an admin controller and records for a member-facing one', () => {
    class AdminMagazinePiecesController {}
    class MagazineController {}

    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('magazine');

    interceptor.intercept(
      contextFor('http', AdminMagazinePiecesController),
      next,
    );
    expect(tally.drain().size).toBe(0);

    interceptor.intercept(contextFor('http', MagazineController), next);
    expect(tally.drain().get('magazine')).toBe(1);
  });
});
