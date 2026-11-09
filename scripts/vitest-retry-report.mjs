// A Vitest reporter that lists every unit test CI had to retry (CI runs the
// unit tests with --retry=1). A retried test that then passed is a flaky
// test to fix: it gets a warning annotation and a row in the job summary.
// Works with main's Vitest 2 (onFinished) and frontend's Vitest 5
// (onTestRunEnd). Usage: vitest run --retry=1 --reporter=default
//   --reporter=../scripts/vitest-retry-report.mjs
import { appendFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

/** @typedef {{ file: string, name: string, retries: number, passed: boolean }} Retried */

/** @param {{ name: string, suite?: { name: string, suite?: unknown, filepath?: string } }} task */
function legacyFullName(task) {
  const names = [task.name];
  let suite = task.suite;
  while (suite && !suite.filepath) {
    if (suite.name) names.unshift(suite.name);
    suite = /** @type {typeof task.suite} */ (suite.suite);
  }
  return names.join(' > ');
}

const posix = (file) => file.replaceAll('\\', '/');

// Annotations need repo-relative paths; the summary reads better from the package.
function repoPath(file) {
  return process.env.GITHUB_WORKSPACE ? relative(process.env.GITHUB_WORKSPACE, resolve(process.cwd(), file)).replaceAll('\\', '/') : file;
}

function escapeCell(text) {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

// Workflow commands end at a newline and treat % specially.
function escapeAnnotation(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export default class RetryReport {
  /** @type {Retried[]} */
  retried = [];
  reported = false;

  // Vitest 3+.
  onTestRunEnd(testModules) {
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const retries = testCase.diagnostic()?.retryCount ?? 0;
        if (retries > 0) {
          this.retried.push({
            file: posix(relative(process.cwd(), testModule.moduleId)),
            name: testCase.fullName,
            retries,
            passed: testCase.result().state === 'passed',
          });
        }
      }
    }
    this.report();
  }

  // Vitest 2.
  onFinished(files = []) {
    if (this.reported) return;
    const visit = (task, file) => {
      if (task.type === 'test' || task.type === 'custom') {
        const retries = task.result?.retryCount ?? 0;
        if (retries > 0) {
          this.retried.push({ file, name: legacyFullName(task), retries, passed: task.result?.state === 'pass' });
        }
      }
      for (const child of task.tasks ?? []) visit(child, file);
    };
    for (const file of files) visit(file, posix(relative(process.cwd(), file.filepath)));
    this.report();
  }

  report() {
    if (this.reported) return;
    this.reported = true;
    const where = `${basename(process.cwd())} unit tests${process.env.RUNNER_OS ? ` (${process.env.RUNNER_OS})` : ''}`;
    const lines = [`### Retried ${where}`, ''];
    if (this.retried.length === 0) {
      lines.push('No test needed a retry.');
    } else {
      lines.push('Each passed retry is a flaky test to fix. A test that failed twice failed the job.', '');
      lines.push('| Test | File | Retries | Result |', '| --- | --- | --- | --- |');
      for (const test of this.retried) {
        lines.push(`| ${escapeCell(test.name)} | \`${escapeCell(test.file)}\` | ${test.retries} | ${test.passed ? 'passed on retry' : 'failed'} |`);
      }
    }
    lines.push('');
    const text = lines.join('\n');
    console.log(`\n${text}`);
    for (const test of this.retried.filter((t) => t.passed)) {
      console.log(`::warning file=${escapeAnnotation(repoPath(test.file))},title=Flaky test retried::${escapeAnnotation(`${test.name} failed, then passed on retry. Fix it; see the job summary.`)}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}
