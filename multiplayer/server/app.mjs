// The multiplayer server: a control listener on 127.0.0.1 for the host, and a
// network listener opened by "Open to network" (like Minecraft's Open to LAN)
// for everyone else. Both serve the editor itself, the WebSocket and files.
// The network port speaks plain HTTP (friends' own copies connect from their
// http://localhost page) and HTTPS (friends who open the address in a browser
// need a secure page), told apart by the first byte of each connection.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage, isPlainObject } from "../../src/modules/multiplayer/shared/doc-ops.js";
import {
	CLIENT_HEADER,
	CONTROL_PORT,
	LIMITS,
	PATHS,
	PROTO,
} from "../../src/modules/multiplayer/shared/protocol.js";
import { loadOrCreateCert } from "./cert.mjs";
import { FileStore } from "./files.mjs";
import { createMediaProxy } from "./media.mjs";
import { Session } from "./session.mjs";
import { serveStatic } from "./static.mjs";
import { acceptWebSocket } from "./ws.mjs";

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/(mp4|webm|ogg))$/;
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": `Content-Type, ${CLIENT_HEADER}`,
	"Access-Control-Allow-Private-Network": "true",
	"Access-Control-Max-Age": "600",
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|localhost)(:\d{1,5})?$/i;

/**
 * Only addresses typed as an IP (or localhost) are served, so a website that
 * points its own domain at this PC (DNS rebinding) is refused.
 * @param {import("node:http").IncomingMessage} req @param {"control" | "lan"} listener
 */
function hostAllowed(req, listener) {
	const host = req.headers.host;
	if (host === undefined) return true;
	if (!IP_HOST.test(host)) return false;
	return listener === "lan" || LOOPBACK.has(host.replace(/:\d+$/, "").toLowerCase());
}

/**
 * Sockets and uploads only from the editor itself: a page on this PC
 * (localhost, any port) or a page this server sent. Tools without a browser
 * send no Origin.
 * @param {import("node:http").IncomingMessage} req
 */
function originAllowed(req) {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	let url;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return LOOPBACK.has(url.hostname) || url.host === req.headers.host;
}

/** Where the self-signed certificate is kept between runs. */
export function defaultDataDir() {
	const local = process.env.LOCALAPPDATA;
	return local ? join(local, "ttml-tool-multiplayer") : join(homedir(), ".ttml-tool-multiplayer");
}

/** IPv4 addresses friends can reach, Radmin VPN (26.x.x.x) first. */
export function lanAddresses() {
	const out = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) {
			const v4 = a.family === "IPv4" || /** @type {unknown} */ (a.family) === 4;
			if (!v4 || a.internal) continue;
			out.push({ address: a.address, label: a.address.startsWith("26.") ? "radmin" : "lan" });
		}
	}
	return out.sort((x, y) => Number(x.label !== "radmin") - Number(y.label !== "radmin"));
}

/**
 * @param {{
 *   distDir: string,
 *   controlPort?: number,
 *   controlHost?: string,
 *   log?: (text: string) => void,
 *   tempRoot?: string,
 *   certDir?: string,
 * }} options
 */
export function createMultiplayerServer(options) {
	const log = options.log ?? ((text) => console.log(text));
	const controlHost = options.controlHost ?? "127.0.0.1";
	const certDir = options.certDir ?? defaultDataDir();
	const files = new FileStore({ root: options.tempRoot });
	const handleMedia = createMediaProxy();
	/** @type {http.Server | null} */
	let control = null;
	let controlPort = options.controlPort ?? CONTROL_PORT;
	/** @type {{ server: net.Server, port: number, sockets: Set<net.Socket>, https: boolean } | null} */
	let lan = null;
	/** @type {Session | null} */
	let session = null;

	/**
	 * @param {"control" | "lan"} listener
	 * @param {{ key: string, cert: string } | null} [tlsOptions]
	 */
	function makeServer(listener, tlsOptions = null) {
		/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
		const onRequest = (req, res) => {
			void handleHttp(req, res, listener).catch((error) => {
				log(`Ошибка запроса: ${error?.message ?? error}`);
				if (!res.headersSent) res.writeHead(500).end();
				else res.destroy();
			});
		};
		const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);
		server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, listener));
		server.on("clientError", (_err, socket) => socket.destroy());
		return server;
	}

	/** @param {net.Server} server @param {number} port @param {string} host */
	function listen(server, port, host) {
		return new Promise((resolve, reject) => {
			const onError = (/** @type {Error} */ error) => reject(error);
			server.once("error", onError);
			server.listen(port, host, () => {
				server.off("error", onError);
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : port);
			});
		});
	}

	/** @param {number} port */
	async function openLan(port) {
		if (lan) return lan.port;
		let tlsOptions = null;
		try {
			tlsOptions = loadOrCreateCert(certDir, lanAddresses().map((a) => a.address));
		} catch (error) {
			log(`HTTPS недоступен, друзьям из браузера будет хуже: ${/** @type {any} */ (error)?.message ?? error}`);
		}
		const plain = makeServer("lan");
		const secure = tlsOptions ? makeServer("lan", tlsOptions) : null;
		/** @type {Set<net.Socket>} */
		const sockets = new Set();
		const server = net.createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => socket.destroy());
			// Connections that never say anything are dropped.
			socket.setTimeout(30000, () => socket.destroy());
			socket.once("data", (chunk) => {
				socket.setTimeout(0);
				socket.pause();
				socket.unshift(chunk);
				// A TLS handshake starts with record type 22.
				(secure && chunk[0] === 0x16 ? secure : plain).emit("connection", socket);
				process.nextTick(() => socket.resume());
			});
		});
		const bound = await listen(server, port, "0.0.0.0");
		lan = { server, port: bound, sockets, https: secure !== null };
		log(`Сеть открыта на порту ${bound}`);
		for (const a of lanAddresses()) {
			const where = a.label === "radmin" ? "Radmin VPN" : "Локальная сеть";
			log(`  ${where}: ${secure ? `https://${a.address}:${bound}` : `${a.address}:${bound}`}`);
		}
		return bound;
	}

	async function closeLan() {
		if (!lan) return;
		const { server, sockets } = lan;
		lan = null;
		await new Promise((resolve) => {
			server.close(() => resolve(undefined));
			for (const socket of sockets) socket.destroy();
		});
		log("Сеть закрыта");
	}

	/** @param {string} reason */
	function onSessionEnd(reason) {
		session = null;
		void files.clear();
		void closeLan();
		log(reason === "host" ? "Хост закрыл сеть" : `Пати завершена (${reason})`);
	}

	/**
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 * @param {"control" | "lan"} listener
	 */
	async function handleHttp(req, res, listener) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		if (!hostAllowed(req, listener) || (req.method === "POST" && !originAllowed(req))) {
			req.resume();
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
			return;
		}
		const encrypted = /** @type {any} */ (req.socket).encrypted === true;
		const host = req.headers.host ?? "";
		if (
			listener === "lan" &&
			lan?.https &&
			!encrypted &&
			!path.startsWith("/mp/") &&
			(req.method === "GET" || req.method === "HEAD") &&
			/^[a-z0-9.\-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i.test(host)
		) {
			// Browser pages need HTTPS here; own copies only use /mp/ over plain HTTP.
			res.writeHead(302, { Location: `https://${host}${req.url ?? "/"}`, "Cache-Control": "no-store" }).end();
			return;
		}
		if (path.startsWith("/mp/")) {
			if (req.method === "OPTIONS") {
				res.writeHead(204, CORS).end();
				return;
			}
			if (path === PATHS.info) return sendJson(res, 200, info(listener));
			if (path === PATHS.upload && req.method === "POST") return upload(req, res, url, "chat", listener);
			if (path === PATHS.audio && req.method === "POST") return upload(req, res, url, "audio", listener);
			if (path.startsWith(PATHS.files) && (req.method === "GET" || req.method === "HEAD")) {
				return serveFile(req, res, path.slice(PATHS.files.length));
			}
			if (path === PATHS.media && req.method === "GET") return handleMedia(res, url);
			res.writeHead(404, CORS).end();
			return;
		}
		return serveStatic(req, res, options.distDir, url);
	}

	/** @param {"control" | "lan"} listener */
	function info(listener) {
		return {
			ok: true,
			app: "ttml-tool-multiplayer",
			proto: PROTO,
			listener,
			lan: lan
				? { open: true, port: lan.port, addresses: lanAddresses(), https: lan.https }
				: { open: false, port: null, addresses: lanAddresses(), https: false },
			session: session ? { members: session.members.size } : null,
		};
	}

	/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
	function sendJson(res, status, body) {
		const text = encodeMessage(body);
		res.writeHead(status, {
			...CORS,
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": String(Buffer.byteLength(text)),
			"Cache-Control": "no-store",
		});
		res.end(text);
	}

	/**
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 * @param {URL} url
	 * @param {"chat" | "audio"} purpose
	 * @param {"control" | "lan"} listener
	 */
	async function upload(req, res, url, purpose, listener) {
		const clientId = String(req.headers[CLIENT_HEADER.toLowerCase()] ?? "");
		const member = session?.byClient.get(clientId);
		const allowed =
			member && member.online && (purpose === "chat" || (member.host && listener === "control"));
		if (!session || !member || !allowed) {
			req.resume();
			return sendJson(res, 403, { ok: false, code: "not-allowed" });
		}
		const limit = purpose === "chat" ? LIMITS.chatFileBytes : LIMITS.audioBytes;
		const declared = Number(req.headers["content-length"] ?? "0");
		if (declared > limit) {
			res.setHeader("Connection", "close");
			sendJson(res, 413, { ok: false, code: "too-large" });
			req.destroy();
			return;
		}
		const current = session;
		let meta;
		try {
			meta = await files.put(req, {
				name: url.searchParams.get("name") ?? "file",
				declaredType: req.headers["content-type"],
				limit,
				purpose,
			});
		} catch (error) {
			if (/** @type {any} */ (error)?.code === "too-large") {
				res.setHeader("Connection", "close");
				return sendJson(res, 413, { ok: false, code: "too-large" });
			}
			throw error;
		}
		if (current.ended || session !== current) {
			await files.remove(meta.id);
			return sendJson(res, 410, { ok: false, code: "closed" });
		}
		if (purpose === "audio") {
			current.setAudio(meta);
			return sendJson(res, 200, { ok: true });
		}
		const message = current.addFileMessage(member, meta, url.searchParams.get("caption") ?? "");
		return sendJson(res, 200, { ok: true, message });
	}

	/**
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 * @param {string} id
	 */
	function serveFile(req, res, id) {
		const meta = /^[a-f0-9]{32}$/.test(id) ? files.get(id) : undefined;
		if (!meta) {
			res.writeHead(404, CORS).end();
			return;
		}
		const inline = INLINE_TYPES.test(meta.mime);
		const encoded = encodeURIComponent(meta.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
		res.writeHead(200, {
			...CORS,
			"Content-Type": inline ? meta.mime : "application/octet-stream",
			"Content-Length": String(meta.size),
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(meta.name)}"; filename*=UTF-8''${encoded}`,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
			"Cross-Origin-Resource-Policy": "cross-origin",
			"Cache-Control": "private, max-age=3600",
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		files.open(meta).on("error", () => res.destroy()).pipe(res);
	}

	/**
	 * @param {http.IncomingMessage} req
	 * @param {import("node:stream").Duplex} socket
	 * @param {Buffer} head
	 * @param {"control" | "lan"} listener
	 */
	function handleUpgrade(req, socket, head, listener) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!hostAllowed(req, listener) || !originAllowed(req)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		if (url.pathname !== PATHS.ws) {
			socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const conn = acceptWebSocket(req, socket, head, { maxPayload: LIMITS.wsPayload });
		if (!conn) return;
		/** @type {import("./session.mjs").Member | null} */
		let member = null;
		/** @type {Session | null} */
		let memberSession = null;
		const helloTimer = setTimeout(() => conn.close(4000, "no hello"), 10000);
		helloTimer.unref?.();
		const fail = (/** @type {string} */ code) => {
			conn.send(encodeMessage({ t: "error", code }));
			conn.close(4000, code);
		};
		conn.on("message", (text) => {
			let msg;
			try {
				msg = decodeMessage(text);
			} catch {
				return;
			}
			if (member && memberSession) {
				memberSession.handle(member, msg);
				return;
			}
			if (!isPlainObject(msg) || msg.t !== "hello") return;
			clearTimeout(helloTimer);
			void hello(conn, msg, listener).then(
				(result) => {
					if (typeof result === "string") fail(result);
					else if (result) {
						member = result.member;
						memberSession = result.session;
					}
				},
				(error) => {
					log(`Ошибка подключения: ${error?.message ?? error}`);
					fail("server-error");
				},
			);
		});
		conn.on("close", () => {
			clearTimeout(helloTimer);
			if (member && memberSession) memberSession.detach(member, conn);
		});
	}

	/**
	 * @param {import("./ws.mjs").WsConn} conn
	 * @param {any} msg
	 * @param {"control" | "lan"} listener
	 * @returns {Promise<string | { member: import("./session.mjs").Member, session: Session } | null>}
	 */
	async function hello(conn, msg, listener) {
		if (msg.proto !== PROTO) return "version";
		if (typeof msg.clientId !== "string" || msg.clientId.length < 1 || msg.clientId.length > 100) {
			return "bad-hello";
		}
		if (msg.role === "host") {
			if (listener !== "control") return "not-allowed";
			if (!session) {
				const open = isPlainObject(msg.open) ? msg.open : null;
				if (!open || !isPlainObject(open.doc)) return "no-session";
				const port = Number.isInteger(open.port) && open.port >= 0 && open.port <= 65535 ? open.port : 0;
				let bound;
				try {
					bound = await openLan(port);
				} catch (error) {
					log(`Не удалось открыть порт ${port}: ${/** @type {any} */ (error)?.code ?? error}`);
					return "port-busy";
				}
				session = new Session({
					doc: open.doc,
					fileName: open.fileName,
					port: bound,
					addresses: lanAddresses(),
					https: Boolean(lan?.https),
					files,
					onEnd: onSessionEnd,
					log,
				});
			} else {
				const host = session.host;
				if (host && host.online && host.clientId !== msg.clientId) return "already-hosting";
			}
			const current = session;
			const member = current.attach(conn, msg, true);
			return member ? { member, session: current } : null;
		}
		if (msg.role === "member") {
			if (!session) return "no-session";
			const existing = session.byClient.get(msg.clientId);
			if (existing?.host && listener !== "control") return "not-allowed";
			const current = session;
			const member = current.attach(conn, msg, false);
			return member ? { member, session: current } : null;
		}
		return "bad-hello";
	}

	return {
		async start() {
			control = makeServer("control");
			controlPort = await listen(control, controlPort, controlHost);
			return controlPort;
		},
		async stop() {
			session?.end("server");
			await closeLan();
			await files.clear();
			if (control) {
				const server = control;
				control = null;
				await new Promise((resolve) => {
					server.close(() => resolve(undefined));
					server.closeAllConnections?.();
				});
			}
		},
		get controlPort() {
			return controlPort;
		},
		get lanPort() {
			return lan?.port ?? null;
		},
	};
}
