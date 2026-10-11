import { describe, expect, it } from 'vitest';
import { compare, readSpec, readTests, report } from './spec-check.js';

const SPEC = `# spec

- **S-01** stated — It is a personal tool. {no test: an intention, not a behaviour}
- **S-10** stated — Time runs left to right.
- **S-11** assumed — A feature is a line.
- **S-12** assumed — Finished lines stay.
- **S-20** open — Planning chats.
- **S-21** open — Same files.
not a statement
- **S-11** assumed — Written twice.
`;

const run = (...tests) => ({
	testResults: [{ name: '/repo/src/lib/a.test.ts', assertionResults: tests.map(([title, status = 'passed']) => ({ title, fullName: `group ${title}`, status })) }]
});

describe('spec check', () => {
	it('reads each statement with its mark, and the reason one needs no test', () => {
		const statements = readSpec(SPEC);
		expect(statements.map((s) => [s.id, s.mark, s.noTest])).toEqual([
			['S-01', 'stated', 'an intention, not a behaviour'],
			['S-10', 'stated', null],
			['S-11', 'assumed', null],
			['S-12', 'assumed', null],
			['S-20', 'open', null],
			['S-21', 'open', null],
			['S-11', 'assumed', null]
		]);
		expect(statements[0].text).toBe('It is a personal tool.');
	});

	it('takes the statements a test names from its title, each case of a table on its own', () => {
		const named = readTests(run(['S-10 lays time out linearly'], ['S-11 S-12 lines'], ['no id here'], ['S-10 again', 'failed']), '/repo');
		expect(named.map((n) => [n.id, n.path, n.passed])).toEqual([
			['S-10', 'src/lib/a.test.ts', true],
			['S-11', 'src/lib/a.test.ts', true],
			['S-12', 'src/lib/a.test.ts', true],
			['S-10', 'src/lib/a.test.ts', false]
		]);
	});

	it('finds what is built and untested, and everything that does not add up', () => {
		const result = compare(readSpec(SPEC), readTests(run(['S-10 time', 'failed'], ['S-20 chats'], ['S-99 nothing'], ['S-01 intent']), '/repo'));
		expect(result.untested.map((s) => s.id)).toEqual(['S-11', 'S-12', 'S-11']);
		expect(result.unknown.map((n) => n.id)).toEqual(['S-99']);
		expect(result.failing.map((n) => n.id)).toEqual(['S-10']);
		expect(result.openButTested.map((s) => s.id)).toEqual(['S-20']);
		expect(result.waivedButTested.map((s) => s.id)).toEqual(['S-01']);
		expect(result.twice.map((s) => s.line)).toEqual([10]);
		expect(result.counts).toMatchObject({ statements: 7, stated: 2, assumed: 3, open: 2, built: 5, tested: 2, waived: 0 });
	});

	it('says nothing more than the totals when everything adds up', () => {
		const clean = '- **S-01** stated — Intent. {no test: an intention}\n- **S-10** stated — Time.\n- **S-20** open — Later.\n';
		const text = report(compare(readSpec(clean), readTests(run(['S-10 time']), '/repo')));
		expect(text).toBe('SPEC.md: 3 statements (2 stated, 0 assumed, 1 open)\n1 of the 2 that are built are named by a test, 1 say they are checked another way');
	});
});
