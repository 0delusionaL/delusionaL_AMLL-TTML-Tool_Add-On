// What multiplayer remembers: per browser (nickname, last port and address)
// and per tab (who this tab is in the party, so a reload rejoins).

import type { MpRole } from "../state";

const NAME_KEY = "multiplayer:name";
const PORT_KEY = "multiplayer:port";
const ADDRESS_KEY = "multiplayer:address";
const CLIENT_KEY = "multiplayer:client";
const RESUME_KEY = "multiplayer:resume";

export interface ResumeInfo {
	role: MpRole;
	sessionId: string;
	address: string | null;
	projectId: string | null;
}

function read(storage: () => Storage, key: string): string | null {
	try {
		return storage().getItem(key);
	} catch {
		return null;
	}
}

function write(storage: () => Storage, key: string, value: string | null) {
	try {
		if (value === null) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
		// Storage can be full or blocked; multiplayer still works without it.
	}
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export const savedName = () => read(local, NAME_KEY) ?? "";
export const saveName = (name: string) => write(local, NAME_KEY, name);
export const savedPort = () => read(local, PORT_KEY) ?? "";
export const savePort = (port: string) => write(local, PORT_KEY, port);
export const savedAddress = () => read(local, ADDRESS_KEY) ?? "";
export const saveAddress = (address: string) => write(local, ADDRESS_KEY, address);

/** One id per tab: two tabs are two players, a reload is the same player. */
export function clientId(): string {
	let id = read(session, CLIENT_KEY);
	if (!id) {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		write(session, CLIENT_KEY, id);
	}
	return id;
}

export function resumeInfo(): ResumeInfo | null {
	const raw = read(session, RESUME_KEY);
	if (!raw) return null;
	try {
		const info = JSON.parse(raw) as ResumeInfo;
		return info && typeof info.sessionId === "string" ? info : null;
	} catch {
		return null;
	}
}

export function saveResumeInfo(info: ResumeInfo | null) {
	write(session, RESUME_KEY, info ? JSON.stringify(info) : null);
}
