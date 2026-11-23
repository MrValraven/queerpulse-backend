import type { SelectQueryBuilder } from 'typeorm';
import type { ModAuditLog } from './entities/mod-audit-log.entity';
import { excludeAuditRowsAboutViewer } from './mod-audit-viewer-filter';

/**
 * SEC-31: the one SQL rule both staff readers of `mod_audit_logs` apply (the
 * governance audit feed and the platform log), written against whichever
 * alias the caller's query builder uses.
 */

const VIEWER_ID = '11111111-1111-4111-8111-111111111111';

interface RecordingBuilder {
  conditions: string[];
  parameterSets: Record<string, unknown>[];
  andWhere: (
    condition: string,
    parameters: Record<string, unknown>,
  ) => RecordingBuilder;
}

function recordingBuilder(): RecordingBuilder {
  const builder: RecordingBuilder = {
    conditions: [],
    parameterSets: [],
    andWhere: (condition, parameters) => {
      builder.conditions.push(condition);
      builder.parameterSets.push(parameters);
      return builder;
    },
  };
  return builder;
}

function applyTo(alias: string): RecordingBuilder {
  const builder = recordingBuilder();
  excludeAuditRowsAboutViewer(
    builder as unknown as SelectQueryBuilder<ModAuditLog>,
    alias,
    VIEWER_ID,
  );
  return builder;
}

describe('excludeAuditRowsAboutViewer (SEC-31)', () => {
  it('drops a sanction on the viewer, a member report against them and their citations', () => {
    const builder = applyTo('log');

    expect(builder.conditions).toHaveLength(3);
    expect(builder.conditions[0]).toContain(
      'log.targetUserId <> CAST(:viewerUserId AS uuid)',
    );
    expect(builder.conditions[1]).toContain(
      "viewer_report.subject_type = 'member'",
    );
    expect(builder.conditions[2]).toContain("log.action <> 'evidence_cited'");
    expect(builder.parameterSets).toEqual([
      { viewerUserId: VIEWER_ID },
      { viewerUserId: VIEWER_ID },
      { viewerUserId: VIEWER_ID },
    ]);
  });

  it('writes the same rule against the platform log alias', () => {
    const builder = applyTo('e');

    expect(builder.conditions.join(' ')).toContain('e.reportId IS NULL');
    expect(builder.conditions.join(' ')).not.toContain('log.');
  });
});
