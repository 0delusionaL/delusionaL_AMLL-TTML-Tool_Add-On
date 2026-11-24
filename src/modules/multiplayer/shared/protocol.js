// Names and limits shared by the multiplayer client and server.

export const PROTO = 1;
export const CONTROL_PORT = 47800;
export const CLIENT_HEADER = "X-MP-Client";

export const PATHS = {
	ws: "/mp/ws",
	info: "/mp/info",
	upload: "/mp/upload",
	audio: "/mp/audio",
	files: "/mp/files/",
	media: "/mp/media",
};

export const LIMITS = {
	chatFileBytes: 7 * 1024 * 1024,
	audioBytes: 250 * 1024 * 1024,
	chatStorageBytes: 256 * 1024 * 1024,
	members: 16,
	messageChars: 2000,
	nameChars: 32,
	fileNameChars: 120,
	wsPayload: 48 * 1024 * 1024,
	chatHistory: 1000,
	pins: 50,
	opLog: 10000,
	maxOpsPerBatch: 50000,
	offlineGraceMs: 120000,
	chatBurst: 20,
	chatBurstWindowMs: 10000,
};

export const CLOSE_CODES = {
	kicked: 4001,
	replaced: 4002,
	closed: 4003,
	timeout: 4004,
};

/** What a member is doing, shown next to their name. */
export const MODES = ["edit", "sync", "preview", "chat"];

/** @param {unknown} name */
export function normalizeName(name) {
	if (typeof name !== "string") return "";
	const clean = name
		.replace(/[\u0000-\u001f\u007f]/g, (ch) => (/\s/.test(ch) ? " " : ""))
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(clean).slice(0, LIMITS.nameChars).join("").trim();
}

/**
 * Reads "26.12.34.56:51234" (or a pasted http:// link) like Minecraft's
 * direct connect. The port is required.
 * @param {unknown} text
 * @returns {{ host: string, port: number } | null}
 */
export function parseAddress(text) {
	if (typeof text !== "string") return null;
	let s = text.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	s = s.split(/[/?#]/)[0];
	let host;
	let portText;
	const v6 = /^\[([0-9a-f:.]+)\]:(\d+)$/i.exec(s);
	if (v6) {
		host = v6[1];
		portText = v6[2];
	} else {
		const i = s.lastIndexOf(":");
		if (i <= 0) return null;
		host = s.slice(0, i);
		portText = s.slice(i + 1);
		if (!/^[a-z0-9.-]+$/i.test(host)) return null;
	}
	if (!/^\d{1,5}$/.test(portText)) return null;
	const port = Number(portText);
	if (port < 1 || port > 65535) return null;
	return { host, port };
}

/** @param {{ host: string, port: number }} address */
export function formatAddress(address) {
	return address.host.includes(":")
		? `[${address.host}]:${address.port}`
		: `${address.host}:${address.port}`;
}
