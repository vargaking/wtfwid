import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PublicSettings, SecretState } from '../model';
import { currentVault, readSettings } from './settings';

// A local tool: read .env straight into process.env, the same in dev and in a build.
try {
	process.loadEnvFile();
} catch {
	// no .env file
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Where settings and remembered sessions live (S-53, S-71). */
export const home = () => process.env.WTFWID_HOME || join(homedir(), '.wtfwid');

/** Saved settings win; anything not saved falls back to the environment (S-73). */
export async function config() {
	const env = process.env;
	const saved = await readSettings(home());
	return {
		linearKey: saved.linearKey || env.LINEAR_API_KEY || null,
		linearTeam: saved.linearTeam ?? (env.WTFWID_LINEAR_TEAM || null),
		githubToken: saved.githubToken || env.GITHUB_TOKEN || env.GH_TOKEN || null,
		githubRepos: saved.githubRepos ?? list(env.WTFWID_GITHUB_REPOS),
		home: home(),
		/** Load a saved snapshot instead of calling anything. For development. */
		snapshotFile: env.WTFWID_SNAPSHOT || null
	};
}

/** What the settings dialog may see. Never the secrets themselves (S-74). */
export async function publicSettings(): Promise<PublicSettings> {
	const env = process.env;
	const saved = await readSettings(home());
	return {
		linearTeam: saved.linearTeam ?? env.WTFWID_LINEAR_TEAM ?? '',
		githubRepos: saved.githubRepos ?? list(env.WTFWID_GITHUB_REPOS),
		linearKey: secretState(saved.linearKey, saved.locked.includes('linearKey'), env.LINEAR_API_KEY),
		githubToken: secretState(saved.githubToken, saved.locked.includes('githubToken'), env.GITHUB_TOKEN || env.GH_TOKEN),
		storage: currentVault() ? 'keychain' : 'file',
		file: join(home(), 'settings.json')
	};
}

function secretState(saved: string | undefined, locked: boolean, fromEnv: string | undefined): SecretState {
	return saved ? 'saved' : locked ? 'locked' : fromEnv ? 'env' : 'none';
}
