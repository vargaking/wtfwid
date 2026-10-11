import { describe, expect, it } from 'vitest';
import type { GraphNode, Lane, NodeState } from './model';
import { search } from './search';

const node = (id: string, title: string, at: string, state: NodeState = 'done'): GraphNode => ({
	id, label: id, title, url: null, at, state, stage: 'ticket', status: 'x', startedAt: at, completedAt: null, sessions: [], prs: []
});
const lane = (id: string, nodes: GraphNode[], closed = false): Lane => ({ id, name: id, project: null, kind: 'project', parent: null, closed, nodes });

const LANES = [
	lane('voice', [
		node('ENG-12', 'Screen share in voice channels', '2026-09-01T09:00:00.000Z'),
		node('ENG-120', 'Echo cancellation', '2026-09-20T09:00:00.000Z'),
		node('ENG-31', 'Screen share: publish the real encodings', '2026-09-10T09:00:00.000Z')
	], true),
	lane('desktop', [node('ENG-204', 'Desktop: screen share picker', '2026-10-02T09:00:00.000Z', 'review'), node('ENG-212', 'Tray icon', '2026-10-03T09:00:00.000Z', 'open')])
];
const ids = (q: string, limit?: number) => search(LANES, q, limit).map((h) => h.node.id);

describe('search', () => {
	it('S-17 finds tickets by words in the title, whatever their case or order, newest first', () => {
		expect(ids('screen share')).toEqual(['ENG-31', 'ENG-12', 'ENG-204']);
		expect(ids('SHARE picker')).toEqual(['ENG-204']);
		expect(ids('nothing like this')).toEqual([]);
		expect(ids('   ')).toEqual([]);
	});

	it('S-17 puts titles that start with what was typed ahead of ones that only contain it', () => {
		expect(ids('screen')).toEqual(['ENG-31', 'ENG-12', 'ENG-204']);
		expect(ids('desktop')).toEqual(['ENG-204']);
	});

	it('S-17 finds a ticket by its ID or just its number, exact match first', () => {
		expect(ids('eng-12')).toEqual(['ENG-12', 'ENG-120']);
		expect(ids('12')).toEqual(['ENG-12', 'ENG-120', 'ENG-212']);
		expect(ids('204')).toEqual(['ENG-204']);
	});

	it('S-17 says which line a ticket is on, finished lines included, and stops at the limit', () => {
		expect(search(LANES, 'echo')[0].lane).toMatchObject({ id: 'voice', closed: true });
		expect(ids('e', 2)).toHaveLength(2);
	});
});
