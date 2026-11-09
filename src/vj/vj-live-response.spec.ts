import { toVjLiveDTO, type VjLiveStageSnapshot } from './vj-live-response';

const CALLER_USER_ID = '11111111-1111-4111-8111-111111111111';
const ALEX_USER_ID = '22222222-2222-4222-8222-222222222222';
const BEA_USER_ID = '33333333-3333-4333-8333-333333333333';
const AT = Date.UTC(2026, 10, 9, 22, 0, 0);

function stageOf(
  ownerUserId: string,
  parts: Partial<Omit<VjLiveStageSnapshot, 'ownerUserId'>> = {},
): VjLiveStageSnapshot {
  return {
    ownerUserId,
    screens: parts.screens ?? [],
    remotes: parts.remotes ?? [
      { connectionId: `remote-${ownerUserId}`, connectedAt: AT },
    ],
  };
}

describe('toVjLiveDTO', () => {
  it('answers no stage and the idle count when nothing is connected', () => {
    expect(
      toVjLiveDTO(
        [stageOf(CALLER_USER_ID, { remotes: [] })],
        new Map(),
        CALLER_USER_ID,
        1,
      ),
    ).toEqual({ stages: [], idleStageCount: 1 });
  });

  it('shapes screens by number, then remotes by attach time, with ISO times', () => {
    const live = toVjLiveDTO(
      [
        {
          ownerUserId: CALLER_USER_ID,
          screens: [
            {
              connectionId: 'screen-two',
              number: 2,
              isLead: false,
              connectedAt: AT + 5,
              isFullscreen: null,
              renderer: null,
            },
            {
              connectionId: 'screen-one',
              number: 1,
              isLead: true,
              connectedAt: AT + 10,
              isFullscreen: true,
              renderer: 'webgl2',
            },
          ],
          remotes: [
            { connectionId: 'remote-late', connectedAt: AT + 20 },
            { connectionId: 'remote-early', connectedAt: AT + 1 },
          ],
        },
      ],
      new Map([[CALLER_USER_ID, 'Tiago Costa']]),
      CALLER_USER_ID,
      0,
    );

    expect(live).toEqual({
      stages: [
        {
          owner: { userId: CALLER_USER_ID, displayName: 'Tiago Costa' },
          isOwnStage: true,
          connections: [
            {
              connectionId: 'screen-one',
              role: 'screen',
              screenNumber: 1,
              isLead: true,
              connectedAt: new Date(AT + 10).toISOString(),
              isFullscreen: true,
              renderer: 'webgl2',
            },
            {
              connectionId: 'screen-two',
              role: 'screen',
              screenNumber: 2,
              isLead: false,
              connectedAt: new Date(AT + 5).toISOString(),
              isFullscreen: null,
              renderer: null,
            },
            {
              connectionId: 'remote-early',
              role: 'remote',
              screenNumber: null,
              isLead: false,
              connectedAt: new Date(AT + 1).toISOString(),
              isFullscreen: null,
              renderer: null,
            },
            {
              connectionId: 'remote-late',
              role: 'remote',
              screenNumber: null,
              isLead: false,
              connectedAt: new Date(AT + 20).toISOString(),
              isFullscreen: null,
              renderer: null,
            },
          ],
        },
      ],
      idleStageCount: 0,
    });
  });

  it('puts the caller stage first, then the other owners by name', () => {
    const live = toVjLiveDTO(
      [stageOf(BEA_USER_ID), stageOf(CALLER_USER_ID), stageOf(ALEX_USER_ID)],
      new Map([
        [BEA_USER_ID, 'Bea Lima'],
        [CALLER_USER_ID, 'Zed Admin'],
        [ALEX_USER_ID, 'Alex Rocha'],
      ]),
      CALLER_USER_ID,
      0,
    );

    expect(live.stages.map((stage) => stage.owner.displayName)).toEqual([
      'Zed Admin',
      'Alex Rocha',
      'Bea Lima',
    ]);
    expect(live.stages.map((stage) => stage.isOwnStage)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('answers an empty name for an owner whose profile is gone', () => {
    const live = toVjLiveDTO(
      [stageOf(ALEX_USER_ID)],
      new Map(),
      CALLER_USER_ID,
      0,
    );
    expect(live.stages[0]?.owner).toEqual({
      userId: ALEX_USER_ID,
      displayName: '',
    });
  });
});
