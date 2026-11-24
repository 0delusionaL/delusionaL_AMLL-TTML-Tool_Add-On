import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { acceptWebSocket } from "../server/ws.mjs";

/** An HTTP server whose WebSocket echoes text and reports closes. */
async function echoServer(options = {}) {
	const closes = [];
	const conns = [];
	const server = http.createServer((_req, res) => res.end("ok"));
	server.on("upgrade", (req, socket, head) => {
		const ws = acceptWebSocket(req, socket, head, options);
		if (!ws) return;
		conns.push(ws);
		ws.on("message", (text) => ws.send(text));
		ws.on("close", (info) => closes.push(info));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		port,
		url: `ws://127.0.0.1:${port}/`,
		closes,
		conns,
		stop: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
}

function frame(opcode, payload, { fin = true, mask = true } = {}) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	const len = data.length;
	const head = [];
	head.push((fin ? 0x80 : 0) | opcode);
	const maskBit = mask ? 0x80 : 0;
	if (len < 126) head.push(maskBit | len);
	else if (len < 65536) head.push(maskBit | 126, len >> 8, len & 255);
	else {
		head.push(maskBit | 127);
		const big = Buffer.alloc(8);
		big.writeBigUInt64BE(BigInt(len));
		head.push(...big);
	}
	if (!mask) return Buffer.concat([Buffer.from(head), data]);
	const key = randomBytes(4);
	const out = Buffer.from(data);
	for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
	return Buffer.concat([Buffer.from(head), key, out]);
}

/** Raw TCP client that completes the handshake and collects server frames. */
async function rawClient(port) {
	const socket = net.connect(port, "127.0.0.1");
	await new Promise((resolve) => socket.once("connect", resolve));
	const key = randomBytes(16).toString("base64");
	socket.write(
		`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	let buf = Buffer.alloc(0);
	const frames = [];
	let handshake = null;
	const waiters = [];
	socket.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		if (!handshake) {
			const end = buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			handshake = buf.subarray(0, end).toString();
			buf = buf.subarray(end + 4);
		}
		while (buf.length >= 2) {
			const opcode = buf[0] & 0x0f;
			let len = buf[1] & 0x7f;
			let off = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				off = 10;
			}
			if (buf.length < off + len) return;
			frames.push({ opcode, payload: buf.subarray(off, off + len) });
			buf = buf.subarray(off + len);
			for (const w of waiters.splice(0)) w();
		}
	});
	const closed = new Promise((resolve) => socket.on("close", resolve));
	const nextFrame = async (opcode) => {
		for (;;) {
			const i = frames.findIndex((f) => f.opcode === opcode);
			if (i >= 0) return frames.splice(i, 1)[0];
			await new Promise((resolve) => waiters.push(resolve));
		}
	};
	return {
		socket,
		send: (buf) => socket.write(buf),
		nextFrame,
		closed,
		accept: () => handshake,
		expectedAccept: createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64"),
	};
}

const closeCode = (f) => f.payload.readUInt16BE(0);

test("echo small and 10 MB messages", async () => {
	const srv = await echoServer();
	const ws = new WebSocket(srv.url);
	const got = [];
	const done = new Promise((resolve) => {
		ws.onmessage = (e) => {
			got.push(e.data);
			if (got.length === 2) resolve();
		};
	});
	await new Promise((resolve) => (ws.onopen = resolve));
	const big = "x".repeat(10 * 1024 * 1024);
	ws.send("hello ✓ мир");
	ws.send(big);
	await done;
	assert.equal(got[0], "hello ✓ мир");
	assert.equal(got[1].length, big.length);
	ws.close();
	await srv.stop();
});

test("handshake accept key is correct", async () => {
	const srv = await echoServer();
	const c = await rawClient(srv.port);
	c.send(frame(1, "ping me"));
	const f = await c.nextFrame(1);
	assert.equal(f.payload.toString(), "ping me");
	assert.match(c.accept(), /^HTTP\/1\.1 101/);
	assert.ok(c.accept().includes(`Sec-WebSocket-Accept: ${c.expectedAccept}`));
	c.socket.destroy();
	await srv.stop();
});

test("fragmented message reassembled with a ping in between", async () => {
	const srv = await echoServer();
	const c = await rawClient(srv.port);
	c.send(frame(1, "Hel", { fin: false }));
	c.send(frame(9, "beat"));
	c.send(frame(0, "lo, ", { fin: false }));
	c.send(frame(0, "world"));
	const pong = await c.nextFrame(10);
	assert.equal(pong.payload.toString(), "beat");
	const echo = await c.nextFrame(1);
	assert.equal(echo.payload.toString(), "Hello, world");
	c.socket.destroy();
	await srv.stop();
});

test("oversized message closes with 1009", async () => {
	const srv = await echoServer({ maxPayload: 1024 });
	const c = await rawClient(srv.port);
	c.send(frame(1, "y".repeat(2000)));
	const f = await c.nextFrame(8);
	assert.equal(closeCode(f), 1009);
	await c.closed;
	await srv.stop();
});

test("oversized fragmented message closes with 1009", async () => {
	const srv = await echoServer({ maxPayload: 1024 });
	const c = await rawClient(srv.port);
	c.send(frame(1, "y".repeat(800), { fin: false }));
	c.send(frame(0, "y".repeat(800)));
	const f = await c.nextFrame(8);
	assert.equal(closeCode(f), 1009);
	await srv.stop();
});

test("invalid utf-8 closes with 1007", async () => {
	const srv = await echoServer();
	const c = await rawClient(srv.port);
	c.send(frame(1, Buffer.from([0xff, 0xfe, 0xfd])));
	const f = await c.nextFrame(8);
	assert.equal(closeCode(f), 1007);
	await srv.stop();
});

test("unmasked client frame closes with 1002", async () => {
	const srv = await echoServer();
	const c = await rawClient(srv.port);
	c.send(frame(1, "naked", { mask: false }));
	const f = await c.nextFrame(8);
	assert.equal(closeCode(f), 1002);
	await srv.stop();
});

test("close handshake reports code", async () => {
	const srv = await echoServer();
	const ws = new WebSocket(srv.url);
	await new Promise((resolve) => (ws.onopen = resolve));
	const closed = new Promise((resolve) => (ws.onclose = resolve));
	ws.close(4001, "bye");
	await closed;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(srv.closes[0], { code: 4001, reason: "bye" });
	await srv.stop();
});

test("server close reaches the client", async () => {
	const srv = await echoServer();
	const ws = new WebSocket(srv.url);
	await new Promise((resolve) => (ws.onopen = resolve));
	const closed = new Promise((resolve) => (ws.onclose = resolve));
	srv.conns[0].close(4000, "kicked");
	const e = await closed;
	assert.equal(e.code, 4000);
	assert.equal(e.reason, "kicked");
	await srv.stop();
});

test("silent peer is dropped after the idle timeout", async () => {
	const srv = await echoServer({ pingIntervalMs: 30, idleTimeoutMs: 120 });
	const c = await rawClient(srv.port);
	// never answer pings
	await c.closed;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(srv.closes[0].code, 1006);
	await srv.stop();
});

test("bad handshake is refused", async () => {
	const srv = await echoServer();
	const socket = net.connect(srv.port, "127.0.0.1");
	await new Promise((resolve) => socket.once("connect", resolve));
	socket.write(
		"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\n\r\n",
	);
	const reply = await new Promise((resolve) => socket.once("data", (d) => resolve(d.toString())));
	assert.match(reply, /^HTTP\/1\.1 400/);
	socket.destroy();
	await srv.stop();
});
