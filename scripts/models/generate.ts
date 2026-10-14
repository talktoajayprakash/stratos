import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';

import {generateMapping} from './generator.js';

try {
  const {values} = parseArgs({
    options: {
      repo: {type: 'string'},
      commit: {type: 'string'},
      output: {type: 'string'},
      check: {type: 'boolean', default: false},
    },
  });
  if (!values.repo || !values.commit || !values.output) {
    throw new Error(
      'Usage: generate --repo <checkout> --commit <full SHA> --output <file> [--check]',
    );
  }
  const snapshot = generateMapping(values.repo, values.commit);
  const json = JSON.stringify(snapshot, null, 2) + '\n';
  if (values.check) {
    if (readFileSync(values.output, 'utf8') !== json) {
      throw new Error('Checked-in mapping differs from source; regenerate it');
    }
  } else {
    mkdirSync(dirname(values.output), {recursive: true});
    writeFileSync(values.output, json);
  }
  console.log(
    JSON.stringify({
      action: values.check ? 'verified' : 'generated',
      sourceCommit: snapshot.source.commit,
      ...snapshot.coverage.totals,
      diagnostics: snapshot.diagnostics.length,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
