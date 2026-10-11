import { describe, expect, it } from 'vitest';
import { ASK, buttonText, CHECK_EVERY_MS, percent } from './update';

describe('the update button', () => {
	it('S-82: says how far the download is, and never 100% before every byte is there', () => {
		expect(percent(0, 1000)).toBe(0);
		expect(percent(430, 1000)).toBe(43);
		expect(percent(999, 1000)).toBe(99);
		expect(percent(126_912_826, 126_912_827)).toBe(99);
		expect(percent(1000, 1000)).toBe(100);
		// a total that is missing or wrong does not divide by zero or run past the end
		expect(percent(5, 0)).toBe(0);
		expect(percent(Number.NaN, 1000)).toBe(0);
		expect(percent(2000, 1000)).toBe(100);
	});

	it('S-82: goes from "Update to" through "Downloading" to "Restart to finish"', () => {
		expect(buttonText('0.1.2', { state: 'idle' })).toBe('Update to v0.1.2');
		expect(buttonText('0.1.2', { state: 'downloading', bytes: 430, total: 1000 })).toBe('Downloading 43%');
		expect(buttonText('0.1.2', { state: 'ready' })).toBe('Restart to finish');
	});

	it('S-82: after a failure there is no button, only the link', () => {
		expect(buttonText('0.1.2', { state: 'failed', message: 'The download has the wrong size.' })).toBeNull();
	});

	it('S-82: asks for an install as JSON, which the built server does not take for a form from another site', () => {
		// found by running the packaged app: a POST with no content type is answered 403 there
		expect(ASK.method).toBe('POST');
		expect(new Headers(ASK.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(ASK.body)).toEqual({});
	});

	it('S-82: the screen asks every 6 hours', () => {
		expect(CHECK_EVERY_MS).toBe(6 * 60 * 60 * 1000);
	});
});
