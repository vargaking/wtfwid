import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Encrypts secrets with the operating system's keychain. The desktop app provides one (S-72). */
export interface Vault {
	encrypt(plain: string): string;
	decrypt(stored: string): string;
}

const SECRETS = ['linearKey', 'githubToken', 'relayToken'] as const;
type SecretName = (typeof SECRETS)[number];

/** What is in settings.json. Secret values are stored as `enc:<…>` or `plain:<…>`. */
interface Stored {
	linearTeam?: string;
	githubRepos?: string[];
	/** Where the relay is that cloud sessions report to (S-91). */
	relayUrl?: string;
	secrets?: Partial<Record<SecretName, string>>;
}

export interface Settings {
	linearTeam?: string;
	githubRepos?: string[];
	linearKey?: string;
	githubToken?: string;
	relayUrl?: string;
	/** The relay's read token. */
	relayToken?: string;
	/** Secrets that are saved but cannot be read here, because another app encrypted them. */
	locked: SecretName[];
}

/** A change to the settings. For a secret: a string sets it, null removes it, undefined keeps it. */
export interface SettingsPatch {
	linearTeam?: string;
	githubRepos?: string[];
	linearKey?: string | null;
	githubToken?: string | null;
	relayUrl?: string;
	relayToken?: string | null;
}

export const currentVault = (): Vault | undefined => (globalThis as { __wtfwidVault?: Vault }).__wtfwidVault;

const file = (home: string) => join(home, 'settings.json');

async function readStored(home: string): Promise<Stored> {
	return readFile(file(home), 'utf8').then(JSON.parse, () => ({}));
}

export async function readSettings(home: string, vault = currentVault()): Promise<Settings> {
	const stored = await readStored(home);
	const out: Settings = { linearTeam: stored.linearTeam, githubRepos: stored.githubRepos, relayUrl: stored.relayUrl, locked: [] };
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
	if (patch.relayUrl !== undefined) stored.relayUrl = patch.relayUrl;
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

/**
 * Whether this can be a relay's address: https, or plain http for one on this machine.
 * The read token is sent there, so it must not go over an open connection to anywhere else.
 */
export function relayAddress(text: string): boolean {
	try {
		const url = new URL(text);
		if (url.username || url.password || url.search || url.hash) return false;
		return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
	} catch {
		return false;
	}
}

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
		// the same repository twice would be read twice
		const typed = (b.githubRepos as string[]).map((r) => r.trim()).filter(Boolean);
		const repos = typed.filter((r, i) => typed.findIndex((o) => o.toLowerCase() === r.toLowerCase()) === i);
		const bad = repos.find((r) => !REPO.test(r));
		if (bad) return `"${bad}" is not a repository. Write it as owner/name.`;
		patch.githubRepos = repos;
	}
	if (b.relayUrl !== undefined) {
		const typed = typeof b.relayUrl === 'string' ? b.relayUrl.trim().replace(/\/+$/, '') : null;
		if (typed === null || (typed && !relayAddress(typed))) return 'The relay address must start with https://. (http:// only for one on this machine.)';
		patch.relayUrl = typed;
	}
	for (const name of SECRETS) {
		const value = b[name];
		if (value === undefined) continue;
		if (value !== null && (typeof value !== 'string' || value.length > 400)) return 'That key does not look right.';
		patch[name] = typeof value === 'string' ? value.trim() : null;
	}
	return patch;
}
