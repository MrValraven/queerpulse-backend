import { EntityManager, In, IsNull } from 'typeorm';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import { quizshowError } from './quizshow-errors';
import type {
  QuizshowResultsPodiumEntry,
  QuizshowResultsResponse,
} from './quizshow.contract';

/** The newest kept session of an event or a game that holds a results card. */
export interface QuizshowResultSessionRow {
  id: string;
  play_mode: 'solo' | 'teams';
  started_at: Date;
  ended_at: Date | null;
}

export interface QuizshowResultsCardInput {
  sessionRow: QuizshowResultSessionRow;
  viewerUserId: string;
  /** An event's host or co-host, or the owner of a game: they see the recap. */
  isOrganizer: boolean;
}

/**
 * The results card of one kept session: the podium by screen or team name,
 * the viewer's own placing, the player and team counts, and the recap for
 * organisers. No user id reaches the card.
 */
export async function buildResultsResponse(
  manager: EntityManager,
  input: QuizshowResultsCardInput,
): Promise<QuizshowResultsResponse> {
  const { sessionRow, viewerUserId, isOrganizer } = input;
  const viewerPlayer = await manager.findOne(QuizshowPlayerRecord, {
    where: {
      sessionId: sessionRow.id,
      userId: viewerUserId,
      removedAt: IsNull(),
    },
  });
  const result = await manager.findOne(QuizshowResultRecord, {
    where: { sessionId: sessionRow.id },
  });
  if (!result) throw quizshowError('quizshow_results_not_found');

  const playerIds = result.podium
    .filter((entry) => entry.kind === 'player')
    .map((entry) => entry.entrantId);
  const teamIds = result.podium
    .filter((entry) => entry.kind === 'team')
    .map((entry) => entry.entrantId);
  if (viewerPlayer?.teamId) teamIds.push(viewerPlayer.teamId);
  const podiumPlayers =
    playerIds.length === 0
      ? []
      : await manager.find(QuizshowPlayerRecord, {
          where: { id: In(playerIds) },
        });
  const teams =
    teamIds.length === 0
      ? []
      : await manager.find(QuizshowTeamRecord, {
          where: { id: In(teamIds) },
        });

  const podium: QuizshowResultsPodiumEntry[] = [];
  for (const entry of result.podium) {
    if (entry.kind === 'player') {
      const player = podiumPlayers.find((row) => row.id === entry.entrantId);
      if (!player) continue;
      podium.push({
        place: entry.place,
        kind: 'player',
        name: player.screenName,
        colorKey: null,
        score: entry.score,
        isMine: viewerPlayer?.id === player.id,
      });
    } else {
      const team = teams.find((row) => row.id === entry.entrantId);
      if (!team) continue;
      podium.push({
        place: entry.place,
        kind: 'team',
        name: team.name,
        colorKey: team.colorKey,
        score: entry.score,
        isMine: viewerPlayer?.teamId === team.id,
      });
    }
  }
  podium.sort(
    (left, right) =>
      left.place - right.place || left.name.localeCompare(right.name),
  );

  const isTeamsPlay = sessionRow.play_mode === 'teams';
  const viewerTeam = viewerPlayer?.teamId
    ? (teams.find((row) => row.id === viewerPlayer.teamId) ?? null)
    : null;
  const viewerPlace = viewerPlayer
    ? result.placings[viewerPlayer.id]
    : undefined;
  const me =
    viewerPlayer && viewerPlace !== undefined
      ? {
          place: viewerPlace,
          score:
            isTeamsPlay && viewerTeam ? viewerTeam.score : viewerPlayer.score,
          teamName: viewerTeam?.name ?? null,
          teamColorKey: viewerTeam?.colorKey ?? null,
        }
      : null;

  const playerCount = await manager.count(QuizshowPlayerRecord, {
    where: { sessionId: sessionRow.id, removedAt: IsNull() },
  });
  const teamCount = isTeamsPlay
    ? await manager.count(QuizshowTeamRecord, {
        where: { sessionId: sessionRow.id },
      })
    : null;

  return {
    sessionId: sessionRow.id,
    playMode: sessionRow.play_mode,
    startedAt: new Date(sessionRow.started_at).toISOString(),
    endedAt: new Date(
      sessionRow.ended_at ?? sessionRow.started_at,
    ).toISOString(),
    podium,
    me,
    playerCount,
    teamCount,
    recap: isOrganizer ? result.questionStats : null,
  };
}
