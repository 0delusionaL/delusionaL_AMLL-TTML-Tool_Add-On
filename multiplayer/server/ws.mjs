// A small WebSocket (RFC 6455) server connection with no dependencies.
// Text messages only; the multiplayer protocol is JSON.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * @typedef {{
 *   maxPayload?: number,
 *   pingIntervalMs?: number,
 *   idleTimeoutMs?: number,
 *   maxBufferedBytes?: number,
 * }} WsOptions
 */

/**
 * Completes the upgrade handshake. Returns null (after answering 400) when
 * the request is not a valid WebSocket upgrade.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 * @param {WsOptions} [options]
 */
export function acceptWebSocket(req, socket, head, options = {}) {
	const key = req.headers["sec-websocket-key"];
	const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
	const connection = String(req.headers.connection ?? "").toLowerCase();
	const valid =
		req.method === "GET" &&
		upgrade === "websocket" &&
		connection.split(",").some((part) => part.trim() === "upgrade") &&
		req.headers["sec-websocket-version"] === "13" &&
		typeof key === "string" &&
		Buffer.from(key, "base64").length === 16;
	if (!valid) {
		socket.end(
			"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
		);
		return null;
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	return new WsConn(socket, head, options);
}

export class WsConn extends EventEmitter {
	/**
	 * @param {import("node:stream").Duplex & { setNoDelay?: (v: boolean) => void, remoteAddress?: string }} socket
	 * @param {Buffer} head
	 * @param {WsOptions} options
	 */
	constructor(socket, head, options) {
		super();
		this.socket = socket;
		this.maxPayload = options.maxPayload ?? 32 * 1024 * 1024;
		this.maxBufferedBytes = options.maxBufferedBytes ?? 96 * 1024 * 1024;
		this.remoteAddress = /** @type {any} */ (socket).remoteAddress ?? "";
		this.isOpen = true;
		/** @type {Buffer[]} */
		this.chunks = [];
		this.buffered = 0;
		/** @type {Buffer[] | null} */
		this.fragments = null;
		this.fragmentsSize = 0;
		this.fragmentOpcode = OP_TEXT;
		this.closeSent = false;
		this.closeEmitted = false;
		this.lastSeen = Date.now();
		this.decoder = new TextDecoder("utf-8", { fatal: true });

		socket.setNoDelay?.(true);
		socket.on("data", (chunk) => this.#onData(chunk));
		// HTTP server sockets allow half-open connections; once the peer is
		// done sending, finish our side too.
		socket.on("end", () => {
			socket.end();
			this.#finish(1006, "");
		});
		socket.on("close", () => this.#finish(1006, ""));
		socket.on("error", () => this.#finish(1006, ""));

		const pingEvery = options.pingIntervalMs ?? 20000;
		const idleLimit = options.idleTimeoutMs ?? 60000;
		this.timer = setInterval(() => {
			if (Date.now() - this.lastSeen > idleLimit) {
				socket.destroy();
				this.#finish(1006, "");
				return;
			}
			this.#write(OP_PING, Buffer.alloc(0));
		}, pingEvery);
		this.timer.unref?.();

		// Bytes that came with the upgrade request are parsed once the caller
		// has attached its listeners.
		if (head && head.length > 0) {
			const early = Buffer.from(head);
			queueMicrotask(() => this.#onData(early));
		}
	}

	get bufferedAmount() {
		return /** @type {any} */ (this.socket).writableLength ?? 0;
	}

	/** @param {string} text */
	send(text) {
		if (!this.isOpen || this.closeSent) return false;
		this.#write(OP_TEXT, Buffer.from(text, "utf8"));
		if (this.bufferedAmount > this.maxBufferedBytes) {
			// The peer stopped reading; holding more would only eat memory.
			this.socket.destroy();
			this.#finish(1006, "");
			return false;
		}
		return true;
	}

	/** @param {number} [code] @param {string} [reason] */
	close(code = 1000, reason = "") {
		if (!this.isOpen) return;
		this.#sendClose(code, reason);
		this.#finish(code, reason);
		const force = setTimeout(() => this.socket.destroy(), 1000);
		force.unref?.();
	}

	/** @param {number} code @param {string} reason */
	#sendClose(code, reason) {
		if (this.closeSent) return;
		this.closeSent = true;
		const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		this.#write(OP_CLOSE, payload);
		this.socket.end();
	}

	/** @param {number} code @param {string} reason */
	#finish(code, reason) {
		this.isOpen = false;
		clearInterval(this.timer);
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		this.emit("close", { code, reason });
	}

	/** Protocol error: tell the peer why and hang up. @param {number} code */
	#fail(code) {
		this.#sendClose(code, "");
		this.#finish(code, "");
		this.chunks = [];
		this.buffered = 0;
		const force = setTimeout(() => this.socket.destroy(), 1000);
		force.unref?.();
	}

	/** @param {number} opcode @param {Buffer} payload */
	#write(opcode, payload) {
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		try {
			this.socket.write(len > 0 ? Buffer.concat([header, payload]) : header);
		} catch {
			// The socket is gone; the close event follows.
		}
	}

	/** @param {Buffer} chunk */
	#onData(chunk) {
		if (!this.isOpen && this.closeSent) return;
		this.lastSeen = Date.now();
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		this.#parse();
	}

	/** Copies the first n buffered bytes without consuming them. @param {number} n */
	#peek(n) {
		if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
		const out = Buffer.alloc(n);
		let off = 0;
		for (const c of this.chunks) {
			const take = Math.min(c.length, n - off);
			c.copy(out, off, 0, take);
			off += take;
			if (off === n) break;
		}
		return out;
	}

	/** @param {number} n */
	#consume(n) {
		this.buffered -= n;
		if (this.chunks[0].length === n) return /** @type {Buffer} */ (this.chunks.shift());
		if (this.chunks[0].length > n) {
			const head = this.chunks[0].subarray(0, n);
			this.chunks[0] = this.chunks[0].subarray(n);
			return head;
		}
		const out = Buffer.alloc(n);
		let off = 0;
		while (off < n) {
			const c = this.chunks[0];
			const take = Math.min(c.length, n - off);
			c.copy(out, off, 0, take);
			off += take;
			if (take === c.length) this.chunks.shift();
			else this.chunks[0] = c.subarray(take);
		}
		return out;
	}

	#parse() {
		while (this.isOpen && this.buffered >= 2) {
			const first = this.#peek(2);
			const fin = (first[0] & 0x80) !== 0;
			const rsv = first[0] & 0x70;
			const opcode = first[0] & 0x0f;
			const masked = (first[1] & 0x80) !== 0;
			let len = first[1] & 0x7f;
			let headerLen = 2;
			if (rsv !== 0 || !masked) return this.#fail(1002);
			if (len === 126) {
				if (this.buffered < 4) return;
				len = this.#peek(4).readUInt16BE(2);
				headerLen = 4;
			} else if (len === 127) {
				if (this.buffered < 10) return;
				const big = this.#peek(10).readBigUInt64BE(2);
				if (big > BigInt(this.maxPayload)) return this.#fail(1009);
				len = Number(big);
				headerLen = 10;
			}
			const isControl = opcode >= 0x8;
			if (isControl && (!fin || len > 125)) return this.#fail(1002);
			if (!isControl && len + (opcode === OP_CONT ? this.fragmentsSize : 0) > this.maxPayload) {
				return this.#fail(1009);
			}
			if (this.buffered < headerLen + 4 + len) return;
			const header = this.#consume(headerLen + 4);
			const mask = header.subarray(headerLen, headerLen + 4);
			const payload = len > 0 ? Buffer.from(this.#consume(len)) : Buffer.alloc(0);
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			this.#frame(fin, opcode, payload);
		}
	}

	/** @param {boolean} fin @param {number} opcode @param {Buffer} payload */
	#frame(fin, opcode, payload) {
		switch (opcode) {
			case OP_PING:
				this.#write(OP_PONG, payload);
				return;
			case OP_PONG:
				return;
			case OP_CLOSE: {
				let code = 1005;
				let reason = "";
				if (payload.length >= 2) {
					code = payload.readUInt16BE(0);
					try {
						reason = this.decoder.decode(payload.subarray(2));
					} catch {
						return this.#fail(1007);
					}
				}
				this.#sendClose(code === 1005 ? 1000 : code, "");
				this.#finish(code, reason);
				return;
			}
			case OP_TEXT:
			case OP_BINARY:
				if (this.fragments !== null) return this.#fail(1002);
				if (fin) return this.#message(opcode, payload);
				this.fragments = [payload];
				this.fragmentsSize = payload.length;
				this.fragmentOpcode = opcode;
				return;
			case OP_CONT:
				if (this.fragments === null) return this.#fail(1002);
				this.fragments.push(payload);
				this.fragmentsSize += payload.length;
				if (fin) {
					const whole = Buffer.concat(this.fragments);
					this.fragments = null;
					this.fragmentsSize = 0;
					this.#message(this.fragmentOpcode, whole);
				}
				return;
			default:
				return this.#fail(1002);
		}
	}

	/** @param {number} opcode @param {Buffer} data */
	#message(opcode, data) {
		if (opcode !== OP_TEXT) return this.#fail(1003);
		let text;
		try {
			text = this.decoder.decode(data);
		} catch {
			return this.#fail(1007);
		}
		this.emit("message", text);
	}
}
