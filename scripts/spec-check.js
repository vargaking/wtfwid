// Compares SPEC.md with the tests: which statements does no test name, and which tests
// name a statement the spec does not have. `pnpm spec` runs the tests and prints the
// report. With --strict it fails when a test names a statement that does not exist,
// an ID is written twice, or a test that names a statement fails.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const STATEMENT = /^- \*\*(S-\d+)\*\* (stated|assumed|open) — (.*)$/;
const ID = /S-\d+/g;

/** The statements in a spec, in the order they are written. */
export function readSpec(text) {
	return text.split('\n').flatMap((line, i) => {
		const m = STATEMENT.exec(line);
		if (!m) return [];
		// "{no test: why}" at the end says the statement is checked some other way
		const waived = /\s*\{no test: ([^}]+)\}\s*$/.exec(m[3]);
		return [{ id: m[1], mark: m[2], text: waived ? m[3].slice(0, waived.index) : m[3], line: i + 1, noTest: waived?.[1] ?? null }];
	});
}

/**
 * Every statement ID named in a test's title, from the test runner's own report.
 * The report has the names as they ran, so a table of cases counts case by case.
 */
export function readTests(report, root = process.cwd()) {
	const named = [];
	for (const file of report.testResults ?? []) {
		for (const test of file.assertionResults ?? []) {
			for (const id of new Set(test.fullName.match(ID) ?? [])) {
				named.push({ id, path: relative(root, file.name), title: test.title, passed: test.status === 'passed' });
			}
		}
	}
	return named;
}

export function compare(statements, named) {
	const known = new Set(statements.map((s) => s.id));
	const tested = new Set(named.map((n) => n.id));
	const twice = statements.filter((s, i) => statements.findIndex((o) => o.id === s.id) !== i);
	return {
		/** built (stated or assumed) and named by no test */
		untested: statements.filter((s) => s.mark !== 'open' && !tested.has(s.id) && !s.noTest),
		/** says it needs no test, and has one anyway */
		waivedButTested: statements.filter((s) => s.noTest && tested.has(s.id)),
		/** named by a test, missing from the spec */
		unknown: named.filter((n) => !known.has(n.id)),
		/** a test that names a statement, and fails */
		failing: named.filter((n) => known.has(n.id) && !n.passed),
		/** marked open, yet a test covers it: the mark is probably out of date */
		openButTested: statements.filter((s) => s.mark === 'open' && tested.has(s.id)),
		/** the same ID written twice */
		twice,
		counts: {
			statements: statements.length,
			stated: statements.filter((s) => s.mark === 'stated').length,
			assumed: statements.filter((s) => s.mark === 'assumed').length,
			open: statements.filter((s) => s.mark === 'open').length,
			built: statements.filter((s) => s.mark !== 'open').length,
			tested: statements.filter((s) => s.mark !== 'open' && tested.has(s.id)).length,
			waived: statements.filter((s) => s.mark !== 'open' && s.noTest && !tested.has(s.id)).length
		}
	};
}

const clip = (text, max = 86) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

export function report(result) {
	const { counts: c } = result;
	const out = [
		`SPEC.md: ${c.statements} statements (${c.stated} stated, ${c.assumed} assumed, ${c.open} open)`,
		`${c.tested} of the ${c.built} that are built are named by a test` + (c.waived ? `, ${c.waived} say they are checked another way` : '')
	];
	const section = (title, rows) => rows.length && out.push('', title, ...rows.map((r) => `  ${r}`));
	section('A test names a statement the spec does not have:', result.unknown.map((n) => `${n.id}  ${n.path}  "${clip(n.title, 60)}"`));
	section('A statement has a failing test:', result.failing.map((n) => `${n.id}  ${n.path}  "${clip(n.title, 60)}"`));
	section('The same ID is written twice:', result.twice.map((s) => `${s.id}  SPEC.md:${s.line}`));
	section('Marked open, but a test covers it. Is the mark out of date?', result.openButTested.map((s) => `${s.id}  ${clip(s.text)}`));
	section('Says "no test", but a test names it. Drop the note?', result.waivedButTested.map((s) => `${s.id}  ${clip(s.text)}`));
	section('Built, and no test names it:', result.untested.map((s) => `${s.id.padEnd(5)} ${s.mark.padEnd(7)} ${clip(s.text)}`));
	return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const dir = mkdtempSync(join(tmpdir(), 'wtfwid-spec-'));
	const file = join(dir, 'tests.json');
	try {
		// vitest exits with 1 when a test fails; the report is written either way
		execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${file}`], { stdio: 'ignore' });
	} catch {
		// read the report below
	}
	const result = compare(readSpec(readFileSync('SPEC.md', 'utf8')), readTests(JSON.parse(readFileSync(file, 'utf8'))));
	rmSync(dir, { recursive: true });
	console.log(report(result));
	if (process.argv.includes('--strict') && (result.unknown.length || result.twice.length || result.failing.length)) process.exit(1);
}
