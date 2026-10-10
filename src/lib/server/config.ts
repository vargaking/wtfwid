import { homedir } from 'node:os';
import { join } from 'node:path';

// A local tool: read .env straight into process.env, the same in dev and in a build.
try {
	process.loadEnvFile();
} catch {
	// no .env file
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function config() {
	const env = process.env;
	return {
		linearKey: env.LINEAR_API_KEY || null,
		linearTeam: env.WTFWID_LINEAR_TEAM || null,
		githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || null,
		githubRepos: list(env.WTFWID_GITHUB_REPOS),
		/** Where the remembered sessions live (S-53). */
		home: env.WTFWID_HOME || join(homedir(), '.wtfwid'),
		/** Load a saved snapshot instead of calling anything. For development. */
		snapshotFile: env.WTFWID_SNAPSHOT || null
	};
}

export type Config = ReturnType<typeof config>;
