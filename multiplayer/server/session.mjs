// One party: its members, the shared document and the order of every edit,
// the chat and the host's audio.

import { createHash, randomBytes } from "node:crypto";
import {
	applyOps,
	encodeMessage,
	isPlainObject,
	validateOps,
} from "../../src/modules/multiplayer/shared/doc-ops.js";
import {
	CLOSE_CODES,
	LIMITS,
	MODES,
	PATHS,
	PROTO,
	normalizeName,
} from "../../src/modules/multiplayer/shared/protocol.js";

/**
 * @typedef {import("./ws.mjs").WsConn} WsConn
 * @typedef {import("./files.mjs").StoredFile} StoredFile
 * @typedef {{
 *   id: string, clientId: string, name: string, color: number, host: boolean,
 *   conn: WsConn | null, online: boolean, mode: string | null, line: number | null,
 *   ping: number | null, lastBatch: number, goneTimer: NodeJS.Timeout | null,
 *   chatTimes: number[],
 * }} Member
 * @typedef {{
 *   id: string, author: string, name: string, color: number, text: string,
 *   at: number, pinned: boolean, pinnedBy: string | null,
 *   file: (ReturnType<typeof publicFile> & { expired?: boolean }) | null,
 * }} ChatMessage
 */

const COLORS = 12;

/** @param {StoredFile} meta */
export function publicFile(meta) {
	return {
		id: meta.id,
		name: meta.name,
		size: meta.size,
		mime: meta.mime,
		kind: meta.kind,
		url: `${PATHS.files}${meta.id}`,
	};
}

export class Session {
	/**
	 * @param {{
	 *   doc: unknown, fileName?: unknown, port: number,
	 *   addresses: { address: string, label: string }[],
	 *   https?: boolean,
	 *   files: import("./files.mjs").FileStore,
	 *   onEnd: (reason: string) => void,
	 *   log?: (text: string) => void,
	 * }} options
	 */
	constructor(options) {
		this.id = randomBytes(12).toString("hex");
		this.doc = options.doc;
		this.fileName =
			typeof options.fileName === "string" ? options.fileName.slice(0, 200) : null;
		this.port = options.port;
		this.addresses = options.addresses;
		this.https = options.https === true;
		this.files = options.files;
		this.onEnd = options.onEnd;
		this.say = options.log ?? (() => {});
		this.seq = 0;
		/** @type {{ seq: number, text: string }[]} */
		this.opLog = [];
		/** @type {Map<string, Member>} */
		this.members = new Map();
		/** @type {Map<string, Member>} */
		this.byClient = new Map();
		/** @type {ChatMessage[]} */
		this.chat = [];
		/** @type {StoredFile | null} */
		this.audio = null;
		this.ended = false;
	}

	/** @param {string} clientId */
	memberIdFor(clientId) {
		return createHash("sha256").update(`${this.id}:${clientId}`).digest("hex").slice(0, 12);
	}

	/** @param {Member} m */
	publicMember(m) {
		return {
			id: m.id,
			name: m.name,
			color: m.color,
			host: m.host,
			online: m.online,
			mode: m.mode,
			line: m.line,
			ping: m.ping,
		};
	}

	get host() {
		for (const m of this.members.values()) if (m.host) return m;
		return null;
	}

	/** @param {object} msg @param {Member | null} [except] */
	broadcast(msg, except = null) {
		const text = encodeMessage(msg);
		for (const m of this.members.values()) {
			if (m !== except && m.conn) m.conn.send(text);
		}
	}

	/** @param {Member} m @param {object} msg */
	sendTo(m, msg) {
		m.conn?.send(encodeMessage(msg));
	}

	/** @param {Member} m @param {string} code */
	error(m, code) {
		this.sendTo(m, { t: "error", code });
	}

	#nextColor() {
		const used = new Set([...this.members.values()].map((m) => m.color));
		for (let c = 0; c < COLORS; c++) if (!used.has(c)) return c;
		return this.members.size % COLORS;
	}

	/**
	 * Adds or reconnects a member and sends the welcome.
	 * @param {WsConn} conn
	 * @param {any} hello
	 * @param {boolean} asHost
	 * @returns {Member | null}
	 */
	attach(conn, hello, asHost) {
		const clientId = String(hello.clientId);
		const name = normalizeName(hello.name) || "Player";
		let member = this.byClient.get(clientId);
		if (!member && asHost) {
			// The host came back from another tab: it takes over its old seat.
			const previous = this.host;
			if (previous) {
				this.byClient.delete(previous.clientId);
				previous.clientId = clientId;
				this.byClient.set(clientId, previous);
				member = previous;
			}
		}
		if (!member) {
			if (this.members.size >= LIMITS.members) {
				conn.send(encodeMessage({ t: "error", code: "full" }));
				conn.close(CLOSE_CODES.closed, "full");
				return null;
			}
			member = {
				id: this.memberIdFor(clientId),
				clientId,
				name,
				color: this.#nextColor(),
				host: asHost,
				conn: null,
				online: false,
				mode: null,
				line: null,
				ping: null,
				lastBatch: 0,
				goneTimer: null,
				chatTimes: [],
			};
			this.members.set(member.id, member);
			this.byClient.set(clientId, member);
		}
		if (member.goneTimer) clearTimeout(member.goneTimer);
		member.goneTimer = null;
		if (member.conn && member.conn !== conn) {
			member.conn.close(CLOSE_CODES.replaced, "replaced");
		}
		member.conn = conn;
		member.online = true;
		member.name = name;

		const resume = isPlainObject(hello.resume) ? hello.resume : null;
		const firstLogged = this.opLog.length > 0 ? this.opLog[0].seq : this.seq + 1;
		const canReplay =
			resume !== null &&
			resume.sessionId === this.id &&
			Number.isInteger(resume.seq) &&
			resume.seq <= this.seq &&
			resume.seq >= firstLogged - 1;

		this.sendTo(member, {
			t: "welcome",
			proto: PROTO,
			sessionId: this.id,
			you: { id: member.id, host: member.host },
			port: this.port,
			addresses: this.addresses,
			https: this.https,
			fileName: this.fileName,
			members: [...this.members.values()].map((m) => this.publicMember(m)),
			chat: this.chat,
			audio: this.audio ? publicFile(this.audio) : null,
			seq: this.seq,
			lastBatch: member.lastBatch,
			resumed: canReplay,
			doc: canReplay ? undefined : this.doc,
		});
		if (canReplay) {
			for (const entry of this.opLog) {
				if (entry.seq > resume.seq) conn.send(entry.text);
			}
		}
		this.broadcast({ t: "member", member: this.publicMember(member) }, member);
		this.say(`${member.host ? "Хост" : "Участник"} ${member.name} в пати (${this.#onlineCount()} онлайн)`);
		return member;
	}

	#onlineCount() {
		let n = 0;
		for (const m of this.members.values()) if (m.online) n++;
		return n;
	}

	/** @param {Member} member @param {WsConn} conn */
	detach(member, conn) {
		if (member.conn !== conn || this.ended || !this.members.has(member.id)) return;
		member.conn = null;
		member.online = false;
		this.broadcast({ t: "member", member: this.publicMember(member) });
		if (!member.host && this.members.has(member.id)) {
			member.goneTimer = setTimeout(() => this.#remove(member, "timeout"), LIMITS.offlineGraceMs);
			member.goneTimer.unref?.();
		}
	}

	/** @param {Member} member @param {string} reason */
	#remove(member, reason) {
		if (!this.members.has(member.id)) return;
		if (member.goneTimer) clearTimeout(member.goneTimer);
		member.conn = null;
		member.online = false;
		this.members.delete(member.id);
		this.byClient.delete(member.clientId);
		this.broadcast({ t: "left", id: member.id, reason });
		this.say(`${member.name} вышел (${reason})`);
	}

	/** @param {Member} member @param {any} msg */
	handle(member, msg) {
		if (this.ended || !isPlainObject(msg)) return;
		switch (msg.t) {
			case "ops":
				return this.#ops(member, msg);
			case "resync":
				return this.sendTo(member, {
					t: "snapshot",
					doc: this.doc,
					seq: this.seq,
					lastBatch: member.lastBatch,
				});
			case "presence":
				return this.#presence(member, msg);
			case "chat":
				return this.#chat(member, msg);
			case "pin":
				return this.#pin(member, msg);
			case "del":
				return this.#delete(member, msg);
			case "kick":
				return this.#kick(member, msg);
			case "close":
				if (!member.host) return this.error(member, "not-allowed");
				return this.end("host");
			case "leave": {
				const conn = member.conn;
				this.#remove(member, "left");
				conn?.close(1000, "left");
				return;
			}
			case "ping":
				return this.sendTo(member, { t: "pong", n: msg.n });
			default:
				return;
		}
	}

	/** @param {Member} member @param {any} msg */
	#ops(member, msg) {
		if (!Number.isInteger(msg.batch)) return;
		if (msg.batch <= member.lastBatch) return; // already applied: a resend after reconnecting
		if (!validateOps(msg.ops, { maxOps: LIMITS.maxOpsPerBatch })) {
			this.sendTo(member, { t: "reject", batch: msg.batch });
			return;
		}
		this.doc = applyOps(this.doc, msg.ops);
		this.seq += 1;
		member.lastBatch = msg.batch;
		const text = encodeMessage({
			t: "ops",
			seq: this.seq,
			from: member.id,
			batch: msg.batch,
			ops: msg.ops,
		});
		this.opLog.push({ seq: this.seq, text });
		if (this.opLog.length > LIMITS.opLog) this.opLog.splice(0, this.opLog.length - LIMITS.opLog);
		for (const m of this.members.values()) m.conn?.send(text);
	}

	/** @param {Member} member @param {any} msg */
	#presence(member, msg) {
		member.mode = MODES.includes(msg.mode) ? msg.mode : null;
		member.line = Number.isInteger(msg.line) && msg.line > 0 && msg.line < 1e6 ? msg.line : null;
		member.ping =
			Number.isFinite(msg.ping) && msg.ping >= 0 && msg.ping < 60000 ? Math.round(msg.ping) : null;
		this.broadcast({ t: "member", member: this.publicMember(member) }, member);
	}

	/** @param {Member} member */
	#allowChat(member) {
		const now = Date.now();
		member.chatTimes = member.chatTimes.filter((t) => now - t < LIMITS.chatBurstWindowMs);
		if (member.chatTimes.length >= LIMITS.chatBurst) return false;
		member.chatTimes.push(now);
		return true;
	}

	/**
	 * @param {Member} member
	 * @param {string} text
	 * @param {ChatMessage["file"]} file
	 */
	addMessage(member, text, file) {
		/** @type {ChatMessage} */
		const message = {
			id: randomBytes(8).toString("hex"),
			author: member.id,
			name: member.name,
			color: member.color,
			text,
			at: Date.now(),
			pinned: false,
			pinnedBy: null,
			file,
		};
		this.chat.push(message);
		while (this.chat.length > LIMITS.chatHistory) {
			const i = this.chat.findIndex((m) => !m.pinned);
			if (i < 0) break;
			const [old] = this.chat.splice(i, 1);
			if (old.file) void this.files.remove(old.file.id);
			this.broadcast({ t: "chatDelete", id: old.id });
		}
		this.broadcast({ t: "chat", message });
		return message;
	}

	/** @param {Member} member @param {any} msg */
	#chat(member, msg) {
		if (typeof msg.text !== "string") return;
		const text = msg.text.replace(/\r\n?/g, "\n").trim();
		if (!text) return;
		if (Array.from(text).length > LIMITS.messageChars) return this.error(member, "too-long");
		if (!this.#allowChat(member)) return this.error(member, "rate");
		this.addMessage(member, text, null);
	}

	/**
	 * A chat message carrying an uploaded file.
	 * @param {Member} member
	 * @param {StoredFile} meta
	 * @param {string} caption
	 */
	addFileMessage(member, meta, caption) {
		const text = Array.from(caption.trim()).slice(0, LIMITS.messageChars).join("");
		const message = this.addMessage(member, text, publicFile(meta));
		this.#trimFiles();
		return message;
	}

	#trimFiles() {
		let total = this.files.bytes("chat");
		for (const message of this.chat) {
			if (total <= LIMITS.chatStorageBytes) break;
			if (!message.file || message.file.expired || message.pinned) continue;
			total -= message.file.size;
			void this.files.remove(message.file.id);
			message.file = { ...message.file, expired: true };
			this.broadcast({ t: "chatUpdate", id: message.id, file: message.file });
		}
	}

	/** @param {Member} member @param {any} msg */
	#pin(member, msg) {
		const message = this.chat.find((m) => m.id === msg.id);
		if (!message) return this.error(member, "not-found");
		const pinned = msg.pinned === true;
		if (pinned && !message.pinned && this.chat.filter((m) => m.pinned).length >= LIMITS.pins) {
			return this.error(member, "too-many-pins");
		}
		message.pinned = pinned;
		message.pinnedBy = pinned ? member.name : null;
		this.broadcast({ t: "chatUpdate", id: message.id, pinned, pinnedBy: message.pinnedBy });
	}

	/** @param {Member} member @param {any} msg */
	#delete(member, msg) {
		const i = this.chat.findIndex((m) => m.id === msg.id);
		if (i < 0) return this.error(member, "not-found");
		const message = this.chat[i];
		if (message.author !== member.id && !member.host) return this.error(member, "not-allowed");
		this.chat.splice(i, 1);
		if (message.file) void this.files.remove(message.file.id);
		this.broadcast({ t: "chatDelete", id: message.id });
	}

	/** @param {Member} member @param {any} msg */
	#kick(member, msg) {
		if (!member.host) return this.error(member, "not-allowed");
		const target = this.members.get(msg.member);
		if (!target || target.host) return this.error(member, "not-found");
		const conn = target.conn;
		if (conn) {
			conn.send(encodeMessage({ t: "kicked" }));
			conn.close(CLOSE_CODES.kicked, "kicked");
		}
		this.#remove(target, "kicked");
	}

	/** @param {StoredFile} meta */
	setAudio(meta) {
		const previous = this.audio;
		this.audio = meta;
		if (previous) void this.files.remove(previous.id);
		this.broadcast({ t: "audio", audio: publicFile(meta) });
		this.say(`Хост раздал аудио: ${meta.name}`);
	}

	/** @param {string} reason */
	end(reason) {
		if (this.ended) return;
		this.broadcast({ t: "closed", reason });
		this.ended = true;
		for (const m of this.members.values()) {
			if (m.goneTimer) clearTimeout(m.goneTimer);
			m.conn?.close(CLOSE_CODES.closed, "closed");
			m.conn = null;
		}
		this.members.clear();
		this.byClient.clear();
		this.onEnd(reason);
	}
}
