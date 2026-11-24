// Finds the multiplayer server on this PC. The editor is usually opened from
// it (http://localhost:47800); during development it runs beside Vite.

import { CONTROL_PORT, PATHS } from "../shared/protocol.js";

export interface ServerInfo {
	ok: boolean;
	app: string;
	proto: number;
	listener: "control" | "lan";
	lan: { open: boolean; port: number | null };
}

export async function probe(base: string, timeoutMs = 1500): Promise<ServerInfo | null> {
	try {
		const res = await fetch(`${base}${PATHS.info}`, {
			signal: AbortSignal.timeout(timeoutMs),
			cache: "no-store",
		});
		if (!res.ok) return null;
		const info = (await res.json()) as ServerInfo;
		return info?.app === "ttml-tool-multiplayer" ? info : null;
	} catch {
		return null;
	}
}

/** The control server on this PC, which is the only place a party can be opened. */
export async function findLocalServer(): Promise<{ base: string; info: ServerInfo } | null> {
	const origin = window.location.origin;
	if (origin.startsWith("http")) {
		const same = await probe(origin);
		if (same?.listener === "control") return { base: origin, info: same };
		if (same?.listener === "lan") return null;
	}
	const base = `http://127.0.0.1:${CONTROL_PORT}`;
	const local = await probe(base);
	return local?.listener === "control" ? { base, info: local } : null;
}

/** When a friend opened the editor from the host's address, that address. */
export async function servedFromHost(): Promise<string | null> {
	const origin = window.location.origin;
	if (!origin.startsWith("http")) return null;
	const info = await probe(origin);
	return info?.listener === "lan" ? window.location.host : null;
}
