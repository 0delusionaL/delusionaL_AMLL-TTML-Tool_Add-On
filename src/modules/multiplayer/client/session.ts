// The party runtime: connection, document sync, chat, audio and the party's
// own undo history. One session per editor store.

import type { createStore } from "jotai";
import { applyOps, decodeMessage, encodeMessage, type Op } from "../shared/doc-ops.js";
import {
	CLOSE_CODES,
	LIMITS,
	PATHS,
	PROTO,
	formatAddress,
	normalizeName,
	parseAddress,
} from "../shared/protocol.js";
import { SyncState } from "../shared/sync-state.js";
import {
	type MpFile,
	type MpMember,
	type MpMessage,
	type MpMode,
	type MpRole,
	mpAddressAtom,
	mpAudioAtom,
	mpCanRedoAtom,
	mpCanUndoAtom,
	mpChatOpenAtom,
	mpCompatAtom,
	mpDocSwitchAtom,
	mpHistoryActiveAtom,
	mpHostAudioAtom,
	mpLanAtom,
	mpMeAtom,
	mpMembersAtom,
	mpMessagesAtom,
	mpPhaseAtom,
	mpPingAtom,
	mpProblemAtom,
	mpRoleAtom,
	mpUnreadAtom,
	mpUploadsAtom,
} from "../state";
import { findLocalServer } from "./local-server";
import {
	clientId,
	resumeInfo,
	saveAddress,
	saveName,
	savePort,
	saveResumeInfo,
	savedName,
	savedPort,
} from "./storage";
import { download, TransferError, upload } from "./transfer";
import { installUndoPatch } from "./undo-patch";
import { getUpstream, missingParts, type Upstream } from "./upstream";

type Store = ReturnType<typeof createStore>;
// biome-ignore lint/suspicious/noExplicitAny: the document is the editor's own shape
type Doc = any;

export type NoticeKind =
	| "joined"
	| "left"
	| "kicked-member"
	| "kicked"
	| "host-closed"
	| "reconnecting"
	| "reconnected"
	| "lost"
	| "audio-loaded"
	| "audio-failed"
	| "doc-switch"
	| "error";

export interface Notice {
	kind: NoticeKind;
	name?: string;
	code?: string;
}

interface Switching {
	projectId: unknown;
	fromProjectId: unknown;
}

const RETRY_DELAYS = [500, 1000, 2000, 3000, 5000];
/** Just under the server's 120 s grace, after which the seat is gone. */
const RETRY_FOR_MS = 110000;
const PING_EVERY_MS = 5000;
const PRESENCE_DELAY_MS = 300;
const UNDO_LIMIT = 100;
const MODES: readonly string[] = ["edit", "sync", "preview"];

const AUDIO_EXT: Record<string, string> = {
	"audio/mpeg": ".mp3",
	"audio/flac": ".flac",
	"audio/x-flac": ".flac",
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"audio/aac": ".aac",
	"audio/webm": ".webm",
};

function randomId() {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class MultiplayerSession {
	private readonly up: Upstream;
	private ws: WebSocket | null = null;
	private sync: SyncState | null = null;
	private base = "";
	private wsUrl = "";
	private role: MpRole | null = null;
	private name = "";
	private myId: string | null = null;
	private sessionId: string | null = null;
	private address: string | null = null;
	private openPort = 0;
	private intentional = false;
	private endReason: string | null = null;
	private failCode: string | null = null;
	private retryStart = 0;
	private retryIndex = 0;
	private retryTimer = 0;
	private pingTimer = 0;
	private presenceTimer = 0;
	private lastPresence = "";
	private unsubs: (() => void)[] = [];
	private flushQueued = false;
	private expectedProjectId: unknown = undefined;
	private switching: Switching | null = null;
	private undoStack: { undo: Op[]; redo: Op[] }[] = [];
	private redoStack: { undo: Op[]; redo: Op[] }[] = [];
	private audioLoader: ((file: File) => unknown) | null = null;
	private loadedAudioId: string | null = null;
	private partyProjectId: string | null = null;
	private listeners = new Set<(notice: Notice) => void>();
	private connectDone: (() => void) | null = null;

	constructor(private readonly store: Store) {
		this.up = getUpstream();
		installUndoPatch(this.up, { undo: () => this.undo(), redo: () => this.redo() });
		const { required, optional } = missingParts();
		store.set(mpCompatAtom, [...required, ...optional]);
	}

	// ---------------------------------------------------------------- public

	on(listener: (notice: Notice) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Host: open the party to the network, like Minecraft's Open to LAN. */
	async openNetwork(opts: { name: string; port?: number | null }) {
		if (!this.beginConnect()) return;
		this.role = "host";
		this.name = normalizeName(opts.name) || "Host";
		saveName(this.name);
		this.openPort = opts.port && opts.port > 0 && opts.port < 65536 ? opts.port : 0;
		if (this.openPort) savePort(String(this.openPort));
		this.store.set(mpRoleAtom, "host");
		const local = await findLocalServer();
		if (!local) {
			this.finish("no-local-server");
			return;
		}
		this.base = local.base;
		this.wsUrl = `${local.base.replace(/^http/, "ws")}${PATHS.ws}`;
		await this.connect();
	}

	/** Member: join the party at "IP:port". */
	async join(opts: { address: string; name: string }) {
		const parsed = parseAddress(opts.address);
		if (!parsed) {
			this.store.set(mpProblemAtom, { code: "bad-address" });
			return;
		}
		if (!this.beginConnect()) return;
		this.role = "member";
		this.name = normalizeName(opts.name) || "Player";
		saveName(this.name);
		this.address = formatAddress(parsed);
		saveAddress(this.address);
		this.store.set(mpRoleAtom, "member");
		this.store.set(mpAddressAtom, this.address);
		// A page opened from the host over HTTPS must stay on HTTPS (mixed content
		// is blocked); an own copy on http://localhost uses plain HTTP.
		const secure = window.location.protocol === "https:";
		this.base = `${secure ? "https" : "http"}://${this.address}`;
		this.wsUrl = `${secure ? "wss" : "ws"}://${this.address}${PATHS.ws}`;
		await this.connect();
	}

	/** Reconnects a tab that was in a party before it reloaded. */
	async resumeIfNeeded() {
		const info = resumeInfo();
		if (!info || this.store.get(mpPhaseAtom) !== "idle") return;
		this.sessionId = info.sessionId;
		this.partyProjectId = info.projectId;
		if (info.role === "host") {
			await this.openNetwork({ name: savedName(), port: Number(savedPort()) || 0 });
		} else if (info.address) {
			await this.join({ address: info.address, name: savedName() });
		}
	}

	leave() {
		if (this.role === "host") {
			this.closeNetwork();
			return;
		}
		this.intentional = true;
		if (!this.send({ t: "leave" })) {
			this.finish(null);
			return;
		}
		window.setTimeout(() => this.ws?.close(1000, "left"), 300);
	}

	closeNetwork() {
		this.intentional = true;
		if (!this.send({ t: "close" })) {
			this.finish(null);
			return;
		}
		const ws = this.ws;
		window.setTimeout(() => {
			if (this.ws === ws && ws) ws.close(1000, "closed");
		}, 2000);
	}

	sendChat(text: string) {
		const clean = text.trim();
		if (!clean) return;
		if (Array.from(clean).length > LIMITS.messageChars) {
			this.emit({ kind: "error", code: "too-long" });
			return;
		}
		this.send({ t: "chat", text: clean });
	}

	async uploadChatFile(file: File, caption = "") {
		if (file.size > LIMITS.chatFileBytes) throw new TransferError("too-large", 413);
		const id = randomId();
		const uploads = this.store.get(mpUploadsAtom);
		this.store.set(mpUploadsAtom, [...uploads, { id, name: file.name, progress: 0 }]);
		const setProgress = (progress: number) =>
			this.store.set(mpUploadsAtom, (list) =>
				list.map((u) => (u.id === id ? { ...u, progress } : u)),
			);
		try {
			const url = `${this.base}${PATHS.upload}?name=${encodeURIComponent(file.name)}&caption=${encodeURIComponent(caption)}`;
			await upload(url, file, clientId(), setProgress);
		} finally {
			this.store.set(mpUploadsAtom, (list) => list.filter((u) => u.id !== id));
		}
	}

	setPinned(id: string, pinned: boolean) {
		this.send({ t: "pin", id, pinned });
	}

	deleteMessage(id: string) {
		this.send({ t: "del", id });
	}

	kick(memberId: string) {
		this.send({ t: "kick", member: memberId });
	}

	/** Host: send the loaded song to everyone; it loads in their editors. */
	async shareAudio() {
		const atom = this.up.loadedAudioAtom;
		const blob = atom ? this.store.get(atom) : null;
		if (!(blob instanceof Blob) || blob.size === 0) {
			this.emit({ kind: "error", code: "no-audio" });
			return;
		}
		if (blob.size > LIMITS.audioBytes) {
			this.emit({ kind: "error", code: "audio-too-large" });
			return;
		}
		const name = (blob as File).name || `audio${AUDIO_EXT[blob.type] ?? ""}`;
		this.store.set(mpHostAudioAtom, { status: "uploading", progress: 0, name });
		try {
			await upload(
				`${this.base}${PATHS.audio}?name=${encodeURIComponent(name)}`,
				blob,
				clientId(),
				(progress) => this.store.set(mpHostAudioAtom, { status: "uploading", progress, name }),
			);
			this.store.set(mpHostAudioAtom, { status: "done", progress: 1, name });
		} catch (error) {
			this.store.set(mpHostAudioAtom, { status: "error", progress: 0, name });
			this.emit({ kind: "error", code: error instanceof TransferError ? error.code : "upload-failed" });
		}
	}

	resolveDocSwitch(choice: "replace" | "restore" | "leave") {
		const sw = this.switching;
		if (!sw || !this.sync) return;
		this.store.set(mpDocSwitchAtom, false);
		this.switching = null;
		const { lyricLinesAtom, projectIdAtom } = this.up;
		if (choice === "replace") {
			if (projectIdAtom) this.expectedProjectId = this.store.get(projectIdAtom);
			this.flush();
			return;
		}
		if (choice === "restore") {
			if (projectIdAtom) {
				this.expectedProjectId = sw.fromProjectId;
				this.store.set(projectIdAtom, sw.fromProjectId);
			}
			if (lyricLinesAtom) this.store.set(lyricLinesAtom, this.sync.displayed);
			this.pruneSelection(this.sync.displayed);
			return;
		}
		this.leave();
	}

	setAudioLoader(loader: ((file: File) => unknown) | null) {
		this.audioLoader = loader;
		const audio = this.store.get(mpAudioAtom);
		if (loader && this.role === "member" && audio.file && this.loadedAudioId !== audio.file.id) {
			void this.loadAudio(audio.file);
		}
	}

	fileUrl(file: Pick<MpFile, "url">) {
		return `${this.base}${file.url}`;
	}

	mediaUrl(link: string) {
		return `${this.base}${PATHS.media}?u=${encodeURIComponent(link)}`;
	}

	debugState() {
		return {
			phase: this.store.get(mpPhaseAtom),
			pending: this.sync?.pending.length ?? 0,
			seq: this.sync?.confirmedSeq ?? null,
		};
	}

	debugDropConnection() {
		this.ws?.close(4999, "test");
	}

	// ------------------------------------------------------------ connection

	private beginConnect() {
		if (this.store.get(mpPhaseAtom) !== "idle") return false;
		const { required } = missingParts();
		if (required.length > 0) {
			this.store.set(mpProblemAtom, { code: "incompatible", detail: required.join(", ") });
			return false;
		}
		this.store.set(mpProblemAtom, null);
		this.store.set(mpPhaseAtom, "connecting");
		this.intentional = false;
		this.endReason = null;
		this.failCode = null;
		return true;
	}

	private connect() {
		return new Promise<void>((resolve) => {
			this.connectDone = resolve;
			this.openSocket();
		});
	}

	private openSocket() {
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.wsUrl);
		} catch {
			this.finish("unreachable");
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			if (this.ws === ws) ws.send(encodeMessage(this.hello()));
		};
		ws.onmessage = (event) => {
			if (this.ws !== ws || typeof event.data !== "string") return;
			let msg: Record<string, unknown>;
			try {
				msg = decodeMessage(event.data);
			} catch {
				return;
			}
			this.onMessage(msg);
		};
		ws.onclose = (event) => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.onClose(event.code);
		};
	}

	private hello() {
		return {
			t: "hello",
			proto: PROTO,
			role: this.role,
			clientId: clientId(),
			name: this.name,
			resume: this.sessionId
				? { sessionId: this.sessionId, seq: this.sync?.confirmedSeq ?? -1 }
				: undefined,
			open:
				this.role === "host"
					? { port: this.openPort, doc: this.currentDoc(), fileName: this.fileName() }
					: undefined,
		};
	}

	private send(msg: object) {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		ws.send(encodeMessage(msg));
		return true;
	}

	private onClose(code: number) {
		this.stopTimers();
		const ended =
			this.intentional ||
			this.endReason !== null ||
			this.failCode !== null ||
			code === CLOSE_CODES.kicked ||
			code === CLOSE_CODES.closed ||
			code === CLOSE_CODES.replaced ||
			(this.connectDone !== null && this.sync === null && this.retryStart === 0);
		if (!ended) {
			this.reconnect();
			return;
		}
		let problem: string | null;
		if (this.failCode) problem = this.failCode;
		else if (this.endReason === "kicked" || code === CLOSE_CODES.kicked) problem = "kicked";
		else if (this.intentional) problem = null;
		else if (this.endReason === "host-closed" || code === CLOSE_CODES.closed) problem = "host-closed";
		else if (code === CLOSE_CODES.replaced) problem = "replaced";
		else problem = "unreachable";
		if (problem === "kicked") this.emit({ kind: "kicked" });
		if (problem === "host-closed") this.emit({ kind: "host-closed" });
		this.finish(problem);
	}

	private reconnect() {
		if (this.retryStart === 0) {
			this.retryStart = Date.now();
			this.retryIndex = 0;
			this.store.set(mpPhaseAtom, "reconnecting");
			this.emit({ kind: "reconnecting" });
		}
		if (Date.now() - this.retryStart > RETRY_FOR_MS) {
			this.emit({ kind: "lost" });
			this.finish("lost");
			return;
		}
		const delay = RETRY_DELAYS[Math.min(this.retryIndex++, RETRY_DELAYS.length - 1)];
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = 0;
			this.openSocket();
		}, delay);
	}

	private finish(problem: string | null) {
		this.stopTimers();
		if (this.retryTimer) window.clearTimeout(this.retryTimer);
		this.retryTimer = 0;
		for (const unsub of this.unsubs) unsub();
		this.unsubs = [];
		const ws = this.ws;
		this.ws = null;
		if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "done");
		this.sync = null;
		this.sessionId = null;
		this.myId = null;
		this.role = null;
		this.address = null;
		this.switching = null;
		this.undoStack = [];
		this.redoStack = [];
		this.loadedAudioId = null;
		this.partyProjectId = null;
		this.retryStart = 0;
		this.intentional = false;
		this.endReason = null;
		this.failCode = null;
		this.lastPresence = "";
		const s = this.store;
		s.set(mpPhaseAtom, "idle");
		s.set(mpRoleAtom, null);
		s.set(mpMeAtom, null);
		s.set(mpMembersAtom, []);
		s.set(mpMessagesAtom, []);
		s.set(mpLanAtom, null);
		s.set(mpAddressAtom, null);
		s.set(mpAudioAtom, { file: null, status: "none", progress: 0 });
		s.set(mpHostAudioAtom, { status: "idle", progress: 0, name: null });
		s.set(mpUploadsAtom, []);
		s.set(mpChatOpenAtom, false);
		s.set(mpUnreadAtom, 0);
		s.set(mpDocSwitchAtom, false);
		s.set(mpHistoryActiveAtom, false);
		s.set(mpCanUndoAtom, false);
		s.set(mpCanRedoAtom, false);
		s.set(mpPingAtom, null);
		s.set(mpProblemAtom, problem ? { code: problem } : null);
		saveResumeInfo(null);
		const done = this.connectDone;
		this.connectDone = null;
		done?.();
	}

	private stopTimers() {
		if (this.pingTimer) window.clearInterval(this.pingTimer);
		if (this.presenceTimer) window.clearTimeout(this.presenceTimer);
		this.pingTimer = 0;
		this.presenceTimer = 0;
	}

	// -------------------------------------------------------------- messages

	// biome-ignore lint/suspicious/noExplicitAny: protocol messages are validated by shape
	private onMessage(msg: any) {
		switch (msg.t) {
			case "welcome":
				return this.onWelcome(msg);
			case "ops":
				return this.onOps(msg);
			case "snapshot":
				return this.onSnapshot(msg);
			case "reject": {
				const display = this.sync?.drop(msg.batch);
				if (display !== undefined && !this.switching) this.show(display);
				return;
			}
			case "member":
				return this.upsertMember(msg.member as MpMember);
			case "left":
				return this.onLeft(msg.id, msg.reason);
			case "chat":
				return this.onChat(msg.message as MpMessage);
			case "chatUpdate":
				return this.updateMessage(msg);
			case "chatDelete":
				this.store.set(mpMessagesAtom, (list) => list.filter((m) => m.id !== msg.id));
				return;
			case "audio":
				return this.onAudio(msg.audio as MpFile | null);
			case "kicked":
				this.endReason = "kicked";
				return;
			case "closed":
				this.endReason = msg.reason === "host" ? "host-closed" : "server-closed";
				if (this.role === "host") this.intentional = true;
				return;
			case "error":
				return this.onError(String(msg.code));
			case "pong":
				return this.onPong(Number(msg.n));
			default:
				return;
		}
	}

	private onError(code: string) {
		if (this.connectDone && !this.sync) {
			this.failCode = code;
			this.ws?.close(1000, "failed");
			return;
		}
		this.emit({ kind: "error", code });
	}

	// biome-ignore lint/suspicious/noExplicitAny: see onMessage
	private onWelcome(w: any) {
		const reconnecting = this.retryStart !== 0;
		this.retryStart = 0;
		this.sessionId = w.sessionId;
		this.myId = w.you.id;
		this.role = w.you.host ? "host" : "member";
		const s = this.store;
		s.set(mpMeAtom, this.myId);
		s.set(mpRoleAtom, this.role);
		s.set(mpMembersAtom, w.members as MpMember[]);
		s.set(mpMessagesAtom, w.chat as MpMessage[]);
		s.set(mpLanAtom, { port: w.port, addresses: w.addresses ?? [], https: w.https === true });
		s.set(mpAudioAtom, (prev) => ({
			file: w.audio,
			status: prev.file?.id === w.audio?.id ? prev.status : "none",
			progress: prev.file?.id === w.audio?.id ? prev.progress : 0,
		}));

		if (this.sync && w.resumed) {
			this.resend(w.lastBatch);
		} else if (this.sync) {
			const display = this.sync.reset(w.doc, w.seq, w.lastBatch);
			if (!this.switching) this.show(display);
			this.resend(w.lastBatch);
		} else {
			const current = this.currentDoc();
			if (this.role === "host" && encodeMessage(w.doc) === encodeMessage(current)) {
				this.sync = new SyncState(current, w.seq, w.lastBatch);
			} else {
				this.sync = new SyncState(w.doc, w.seq, w.lastBatch);
				this.loadPartyDoc(w.doc, w.fileName);
			}
		}

		this.bind();
		s.set(mpHistoryActiveAtom, true);
		s.set(mpPhaseAtom, "connected");
		s.set(mpProblemAtom, null);
		saveResumeInfo({
			role: this.role,
			sessionId: w.sessionId,
			address: this.address,
			projectId: this.partyProjectId,
		});
		this.startTimers();
		this.lastPresence = "";
		this.schedulePresence();
		if (this.role === "member" && w.audio) void this.loadAudio(w.audio);
		if (reconnecting) this.emit({ kind: "reconnected" });
		const done = this.connectDone;
		this.connectDone = null;
		done?.();
	}

	// biome-ignore lint/suspicious/noExplicitAny: see onMessage
	private onOps(msg: any) {
		if (!this.sync || !this.myId) return;
		this.flush();
		const res = this.sync.remote(msg, this.myId);
		if (res.gap) {
			this.send({ t: "resync" });
			return;
		}
		if (res.display && !this.switching) {
			this.show(res.display);
			if (res.removed) this.pruneSelection(res.display);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: see onMessage
	private onSnapshot(msg: any) {
		if (!this.sync) return;
		const display = this.sync.reset(msg.doc, msg.seq, msg.lastBatch);
		if (!this.switching) {
			this.show(display);
			this.pruneSelection(display);
		}
		this.resend(msg.lastBatch);
	}

	private resend(lastBatch: number) {
		if (!this.sync) return;
		for (const p of this.sync.pending) {
			if (p.batch > lastBatch) this.send({ t: "ops", batch: p.batch, ops: p.ops });
		}
	}

	private upsertMember(member: MpMember) {
		const list = this.store.get(mpMembersAtom);
		const known = list.some((m) => m.id === member.id);
		this.store.set(
			mpMembersAtom,
			known ? list.map((m) => (m.id === member.id ? member : m)) : [...list, member],
		);
		if (!known && member.id !== this.myId) this.emit({ kind: "joined", name: member.name });
	}

	private onLeft(id: string, reason: string) {
		const list = this.store.get(mpMembersAtom);
		const member = list.find((m) => m.id === id);
		this.store.set(mpMembersAtom, list.filter((m) => m.id !== id));
		if (member && id !== this.myId) {
			this.emit({ kind: reason === "kicked" ? "kicked-member" : "left", name: member.name });
		}
	}

	private onChat(message: MpMessage) {
		this.store.set(mpMessagesAtom, (list) => [...list, message]);
		if (message.author !== this.myId && !this.store.get(mpChatOpenAtom)) {
			this.store.set(mpUnreadAtom, (n) => n + 1);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: see onMessage
	private updateMessage(msg: any) {
		this.store.set(mpMessagesAtom, (list) =>
			list.map((m) => {
				if (m.id !== msg.id) return m;
				const next = { ...m };
				if (typeof msg.pinned === "boolean") {
					next.pinned = msg.pinned;
					next.pinnedBy = msg.pinnedBy ?? null;
				}
				if (msg.file) next.file = msg.file;
				return next;
			}),
		);
	}

	private onAudio(audio: MpFile | null) {
		this.store.set(mpAudioAtom, { file: audio, status: "none", progress: 0 });
		if (this.role === "member" && audio) void this.loadAudio(audio);
	}

	private async loadAudio(file: MpFile) {
		if (this.loadedAudioId === file.id) return;
		if (!this.audioLoader) {
			this.store.set(mpAudioAtom, { file, status: this.up.useLoadAudio ? "none" : "error", progress: 0 });
			return;
		}
		this.loadedAudioId = file.id;
		this.store.set(mpAudioAtom, { file, status: "downloading", progress: 0 });
		try {
			const blob = await download(this.fileUrl(file), (progress) =>
				this.store.set(mpAudioAtom, { file, status: "downloading", progress }),
			);
			if (this.store.get(mpAudioAtom).file?.id !== file.id) return;
			await this.audioLoader(new File([blob], file.name, { type: file.mime }));
			this.store.set(mpAudioAtom, { file, status: "loaded", progress: 1 });
			this.emit({ kind: "audio-loaded", name: file.name });
		} catch {
			this.loadedAudioId = null;
			this.store.set(mpAudioAtom, { file, status: "error", progress: 0 });
			this.emit({ kind: "audio-failed", name: file.name });
		}
	}

	private onPong(sent: number) {
		if (!Number.isFinite(sent)) return;
		this.store.set(mpPingAtom, Math.max(0, Math.round(performance.now() - sent)));
		this.schedulePresence();
	}

	private startTimers() {
		this.stopTimers();
		this.pingTimer = window.setInterval(() => {
			this.send({ t: "ping", n: performance.now() });
		}, PING_EVERY_MS);
		this.send({ t: "ping", n: performance.now() });
	}

	// -------------------------------------------------------------- document

	private currentDoc(): Doc {
		const atom = this.up.lyricLinesAtom;
		return atom ? this.store.get(atom) : null;
	}

	private fileName(): string | null {
		const atom = this.up.saveFileNameAtom;
		const value = atom ? this.store.get(atom) : null;
		return typeof value === "string" ? value : null;
	}

	/** Puts a document the session computed into the editor. */
	private show(doc: Doc) {
		const atom = this.up.lyricLinesAtom;
		if (atom && this.store.get(atom) !== doc) this.store.set(atom, doc);
	}

	/** Replaces the editor's document with the party's, as a separate project. */
	private loadPartyDoc(doc: Doc, fileName: unknown) {
		const { selectedLinesAtom, selectedWordsAtom, projectIdAtom, startFreshLyricDocumentAtom, saveFileNameAtom } = this.up;
		this.show(doc);
		if (selectedLinesAtom) this.store.set(selectedLinesAtom, new Set());
		if (selectedWordsAtom) this.store.set(selectedWordsAtom, new Set());
		if (this.role === "member" && projectIdAtom) {
			this.partyProjectId ??= `party-${randomId()}`;
			this.expectedProjectId = this.partyProjectId;
			this.store.set(projectIdAtom, this.partyProjectId);
		}
		if (startFreshLyricDocumentAtom) this.store.set(startFreshLyricDocumentAtom);
		if (this.role === "member" && saveFileNameAtom && typeof fileName === "string" && fileName) {
			this.store.set(saveFileNameAtom, fileName);
		}
	}

	private bind() {
		if (this.unsubs.length > 0) return;
		const { lyricLinesAtom, projectIdAtom, toolModeAtom, selectedLinesAtom } = this.up;
		if (!lyricLinesAtom) return;
		this.unsubs.push(this.store.sub(lyricLinesAtom, () => this.queueFlush()));
		if (projectIdAtom) {
			this.expectedProjectId = this.store.get(projectIdAtom);
			this.unsubs.push(this.store.sub(projectIdAtom, () => this.onProjectChange()));
		}
		const presence = () => this.schedulePresence();
		if (toolModeAtom) this.unsubs.push(this.store.sub(toolModeAtom, presence));
		if (selectedLinesAtom) this.unsubs.push(this.store.sub(selectedLinesAtom, presence));
		this.unsubs.push(this.store.sub(mpChatOpenAtom, presence));
	}

	private queueFlush() {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			this.flush();
		});
	}

	/** Turns the editor's latest change into a batch for the server. */
	private flush() {
		const atom = this.up.lyricLinesAtom;
		if (!this.sync || !atom || this.switching) return;
		const value = this.store.get(atom);
		if (value === this.sync.displayed) return;
		const res = this.sync.local(value);
		if (res.display !== value) this.store.set(atom, res.display);
		if (res.batch) {
			this.send({ t: "ops", batch: res.batch.batch, ops: res.batch.ops });
			if (res.undo) this.pushUndo(res.undo, res.batch.ops);
		}
	}

	private onProjectChange() {
		const { projectIdAtom } = this.up;
		if (!projectIdAtom || !this.sync) return;
		const id = this.store.get(projectIdAtom);
		if (id === this.expectedProjectId) return;
		if (this.switching) {
			this.switching.projectId = id;
			return;
		}
		this.switching = { projectId: id, fromProjectId: this.expectedProjectId };
		queueMicrotask(() => this.checkSwitch());
	}

	/** A new project id with the same document is not a different file. */
	private checkSwitch() {
		const sw = this.switching;
		const atom = this.up.lyricLinesAtom;
		if (!sw || !this.sync || !atom) return;
		if (this.store.get(atom) === this.sync.displayed) {
			this.expectedProjectId = sw.projectId;
			this.switching = null;
			return;
		}
		this.store.set(mpDocSwitchAtom, true);
		this.emit({ kind: "doc-switch" });
	}

	private pruneSelection(doc: Doc) {
		const { selectedLinesAtom, selectedWordsAtom } = this.up;
		const lines = new Set<string>();
		const words = new Set<string>();
		for (const line of doc?.lyricLines ?? []) {
			lines.add(line?.id);
			for (const word of line?.words ?? []) words.add(word?.id);
		}
		const prune = (atom: typeof selectedLinesAtom, keep: Set<string>) => {
			if (!atom) return;
			const current = this.store.get(atom);
			if (!(current instanceof Set)) return;
			for (const id of current) {
				if (!keep.has(id)) {
					this.store.set(atom, new Set([...current].filter((x) => keep.has(x))));
					return;
				}
			}
		};
		prune(selectedLinesAtom, lines);
		prune(selectedWordsAtom, words);
	}

	// --------------------------------------------------------------- history

	private pushUndo(undo: Op[], redo: Op[]) {
		this.undoStack.push({ undo, redo });
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = [];
		this.historyFlags();
	}

	private undo() {
		const entry = this.undoStack.pop();
		if (entry) {
			this.applyHistory(entry.undo);
			this.redoStack.push(entry);
		}
		this.historyFlags();
	}

	private redo() {
		const entry = this.redoStack.pop();
		if (entry) {
			this.applyHistory(entry.redo);
			this.undoStack.push(entry);
		}
		this.historyFlags();
	}

	private applyHistory(ops: Op[]) {
		if (!this.sync || this.switching) return;
		this.flush();
		const next = applyOps(this.sync.displayed, ops);
		const res = this.sync.local(next, { trusted: true });
		this.show(res.display);
		if (res.batch) this.send({ t: "ops", batch: res.batch.batch, ops: res.batch.ops });
	}

	private historyFlags() {
		this.store.set(mpCanUndoAtom, this.undoStack.length > 0);
		this.store.set(mpCanRedoAtom, this.redoStack.length > 0);
	}

	// -------------------------------------------------------------- presence

	private schedulePresence() {
		if (this.presenceTimer || this.store.get(mpPhaseAtom) === "idle") return;
		this.presenceTimer = window.setTimeout(() => {
			this.presenceTimer = 0;
			this.sendPresence();
		}, PRESENCE_DELAY_MS);
	}

	private sendPresence() {
		const { toolModeAtom } = this.up;
		const tool = toolModeAtom ? String(this.store.get(toolModeAtom)) : "";
		const mode: MpMode | null = this.store.get(mpChatOpenAtom)
			? "chat"
			: MODES.includes(tool)
				? (tool as MpMode)
				: null;
		const line = this.selectedLineNumber();
		const ping = this.store.get(mpPingAtom);
		const key = JSON.stringify([mode, line, ping]);
		if (key === this.lastPresence) return;
		if (!this.send({ t: "presence", mode, line, ping })) return;
		this.lastPresence = key;
		const me = this.myId;
		this.store.set(mpMembersAtom, (list) =>
			list.map((m) => (m.id === me ? { ...m, mode, line, ping } : m)),
		);
	}

	private selectedLineNumber(): number | null {
		const { selectedLinesAtom } = this.up;
		const selected = selectedLinesAtom ? this.store.get(selectedLinesAtom) : null;
		if (!(selected instanceof Set) || selected.size === 0) return null;
		const lines: { id?: string }[] = this.currentDoc()?.lyricLines ?? [];
		const index = lines.findIndex((l) => selected.has(l?.id));
		return index >= 0 ? index + 1 : null;
	}

	private emit(notice: Notice) {
		for (const listener of this.listeners) {
			try {
				listener(notice);
			} catch {
				// A broken listener must not stop the session.
			}
		}
	}
}

const sessions = new WeakMap<Store, MultiplayerSession>();

export function getSession(store: Store): MultiplayerSession {
	let session = sessions.get(store);
	if (!session) {
		session = new MultiplayerSession(store);
		sessions.set(store, session);
	}
	return session;
}
