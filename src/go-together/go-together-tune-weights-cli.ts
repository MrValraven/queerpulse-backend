import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MatchTrainingRow } from './entities/match-training-row.entity';
import {
  GO_TOGETHER_WEIGHTS,
  ScoredComponent,
  SCORING_VERSION,
} from './go-together-scoring';
import {
  MIN_TRAINING_ROWS,
  TrainingExample,
  TuneResult,
  fitWeights,
} from './go-together-tune';

const PROPOSED_WEIGHTS_FILE_NAME = 'go-together-weights.proposed.json';
const COMPONENTS = Object.keys(GO_TOGETHER_WEIGHTS) as ScoredComponent[];

/**
 * Offline weight tuning for `GO_TOGETHER_WEIGHTS`. Reads every de-identified
 * `match_training_rows` row for the running `SCORING_VERSION`, fits a
 * shrunk logistic model against them, and writes the proposal to a JSON file
 * for a human to compare and copy into `go-together-scoring.ts` by hand.
 *
 * This never touches source files and never writes to the database: it is a
 * read-only report, the same way `recognition:rebase` reports by default.
 *
 * USAGE
 *   pnpm go-together:tune
 */
async function loadTrainingExamples(
  dataSource: DataSource,
): Promise<TrainingExample[]> {
  const rows = await dataSource
    .getRepository(MatchTrainingRow)
    .find({ where: { scoringVersion: SCORING_VERSION } });
  return rows.map((row) => ({
    components: row.components,
    mutualYes: row.mutualYes,
  }));
}

function formatWeightsTable(result: TuneResult): string {
  const header = `${'component'.padEnd(14)}${'current'.padStart(10)}${'proposed'.padStart(10)}${'delta'.padStart(10)}`;
  const lines = COMPONENTS.map((component) => {
    const current = GO_TOGETHER_WEIGHTS[component];
    const proposed = result.weights[component];
    const delta = proposed - current;
    return `${component.padEnd(14)}${current.toFixed(3).padStart(10)}${proposed.toFixed(3).padStart(10)}${(delta >= 0 ? '+' : '') + delta.toFixed(3).padStart(9)}`;
  });
  return [header, ...lines].join('\n');
}

function printReport(result: TuneResult): void {
  const heading = 'Go together weight tuning report';
  console.log(`\n${heading}\n${'='.repeat(heading.length)}\n`);
  console.log(formatWeightsTable(result));
  console.log('');
  console.log(`Training rows used:    ${result.trainingCount}`);
  console.log(`Held out rows used:    ${result.heldOutCount}`);
  console.log(`Held out log loss:     ${result.heldOutLogLoss.toFixed(4)}`);
  console.log(`Baseline log loss:     ${result.baselineLogLoss.toFixed(4)}`);
  console.log('');
  console.log(
    `Proposed weights written to ${PROPOSED_WEIGHTS_FILE_NAME}. Nothing was written to the database.`,
  );
  console.log(
    'A human reviews the proposal and copies it into go-together-scoring.ts by hand.\n',
  );
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const dataSource = app.get(DataSource, { strict: false });
    const examples = await loadTrainingExamples(dataSource);
    if (examples.length < MIN_TRAINING_ROWS) {
      console.log(
        `Only ${examples.length} training row(s) for scoring version ${SCORING_VERSION}; need at least ${MIN_TRAINING_ROWS}. Nothing to do.\n`,
      );
      return;
    }
    const result = fitWeights(examples);
    printReport(result);
    writeFileSync(
      PROPOSED_WEIGHTS_FILE_NAME,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
