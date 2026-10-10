import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Encrypts secrets with the operating system's keychain. The desktop app provides one (S-72). */
export interface Vault {
	encrypt(plain: string): string;
	decrypt(stored: string): string;
}

const SECRETS = ['linearKey', 'githubToken'] as const;
type SecretName = (typeof SECRETS)[number];

/** What is in settings.json. Secret values are stored as `enc:<…>` or `plain:<…>`. */
interface Stored {
	linearTeam?: string;
	githubRepos?: string[];
	secrets?: Partial<Record<SecretName, string>>;
}

export interface Settings {
	linearTeam?: string;
	githubRepos?: string[];
	linearKey?: string;
	githubToken?: string;
	/** Secrets that are saved but cannot be read here, because another app encrypted them. */
	locked: SecretName[];
}

/** A change to the settings. For a secret: a string sets it, null removes it, undefined keeps it. */
export interface SettingsPatch {
	linearTeam?: string;
	githubRepos?: string[];
	linearKey?: string | null;
	githubToken?: string | null;
}

export const currentVault = (): Vault | undefined => (globalThis as { __wtfwidVault?: Vault }).__wtfwidVault;

const file = (home: string) => join(home, 'settings.json');

async function readStored(home: string): Promise<Stored> {
	return readFile(file(home), 'utf8').then(JSON.parse, () => ({}));
}

export async function readSettings(home: string, vault = currentVault()): Promise<Settings> {
	const stored = await readStored(home);
	const out: Settings = { linearTeam: stored.linearTeam, githubRepos: stored.githubRepos, locked: [] };
	for (const name of SECRETS) {
		const value = stored.secrets?.[name];
		if (!value) continue;
		if (value.startsWith('plain:')) out[name] = value.slice(6);
		else if (value.startsWith('enc:') && vault) {
			try {
				out[name] = vault.decrypt(value.slice(4));
			} catch {
				out.locked.push(name);
			}
		} else out.locked.push(name);
	}
	return out;
}

export async function writeSettings(home: string, patch: SettingsPatch, vault = currentVault()): Promise<void> {
	const stored = await readStored(home);
	if (patch.linearTeam !== undefined) stored.linearTeam = patch.linearTeam;
	if (patch.githubRepos !== undefined) stored.githubRepos = patch.githubRepos;
	const secrets = { ...stored.secrets };
	for (const name of SECRETS) {
		const value = patch[name];
		if (value === null || value === '') delete secrets[name];
		else if (value !== undefined) secrets[name] = vault ? `enc:${vault.encrypt(value)}` : `plain:${value}`;
	}
	stored.secrets = secrets;
	await mkdir(home, { recursive: true });
	await writeFile(file(home), JSON.stringify(stored, null, '\t'), { mode: 0o600 });
	await chmod(file(home), 0o600); // the mode above only applies when the file is new
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Checks what the settings dialog sent. Returns the patch, or a message saying what is wrong. */
export function parsePatch(body: unknown): SettingsPatch | string {
	if (typeof body !== 'object' || body === null) return 'Expected an object.';
	const b = body as Record<string, unknown>;
	const patch: SettingsPatch = {};

	if (b.linearTeam !== undefined) {
		if (typeof b.linearTeam !== 'string' || !/^[A-Za-z0-9]{0,10}$/.test(b.linearTeam.trim())) {
			return 'The team key is the short prefix of your issue IDs, like ENG.';
		}
		patch.linearTeam = b.linearTeam.trim().toUpperCase();
	}
	if (b.githubRepos !== undefined) {
		if (!Array.isArray(b.githubRepos) || b.githubRepos.some((r) => typeof r !== 'string')) return 'Repositories must be a list.';
		const repos = (b.githubRepos as string[]).map((r) => r.trim()).filter(Boolean);
		const bad = repos.find((r) => !REPO.test(r));
		if (bad) return `"${bad}" is not a repository. Write it as owner/name.`;
		patch.githubRepos = repos;
	}
	for (const name of SECRETS) {
		const value = b[name];
		if (value === undefined) continue;
		if (value !== null && (typeof value !== 'string' || value.length > 400)) return 'That key does not look right.';
		patch[name] = typeof value === 'string' ? value.trim() : null;
	}
	return patch;
}
