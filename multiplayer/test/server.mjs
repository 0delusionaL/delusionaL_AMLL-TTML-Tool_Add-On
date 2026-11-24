import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createMultiplayerServer } from "../server/app.mjs";
import { applyOps, decodeMessage, diffDoc, encodeMessage } from "../../src/modules/multiplayer/shared/doc-ops.js";
import { LIMITS, PROTO } from "../../src/modules/multiplayer/shared/protocol.js";
import { makeDoc, rng, wire } from "./helpers.mjs";

let dist;
before(() => {
	dist = mkdtempSync(join(tmpdir(), "mp-dist-"));
	mkdirSync(join(dist, "assets"));
	mkdirSync(join(dist, "kuromoji-dict"));
	writeFileSync(join(dist, "index.html"), "<!doctype html><title>TTML Tool</title>");
	writeFileSync(join(dist, "assets", "app-123.js"), "console.log(1)");
	writeFileSync(join(dist, "kuromoji-dict", "base.dat.gz"), Buffer.from([0x1f, 0x8b, 1, 2]));
	writeFileSync(join(dist, "decode-audio.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d]));
});
after(() => rmSync(dist, { recursive: true, force: true }));

async function startServer(t) {
	const server = createMultiplayerServer({ distDir: dist, controlPort: 0, log: () => {}, certDir: join(dist, "certs") });
	await server.start();
	t.after(() => server.stop());
	return server;
}

/** WebSocket client with a typed inbox. */
async function client(url) {
	const ws = new WebSocket(url);
	const inbox = [];
	const waiters = [];
	let closeEvent = null;
	ws.onmessage = (e) => {
		inbox.push(decodeMessage(e.data));
		for (const w of waiters.splice(0)) w();
	};
	const closed = new Promise((resolve) => {
		ws.onclose = (e) => {
			closeEvent = { code: e.code, reason: e.reason };
			resolve(closeEvent);
			for (const w of waiters.splice(0)) w();
		};
	});
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	const next = async (type, ms = 3000) => {
		const deadline = Date.now() + ms;
		for (;;) {
			const i = inbox.findIndex((m) => m.t === type);
			if (i >= 0) return inbox.splice(i, 1)[0];
			if (closeEvent && type !== "__close") throw new Error(`closed before ${type}: ${JSON.stringify(closeEvent)}`);
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timeout waiting for ${type}; inbox: ${JSON.stringify(inbox.map((m) => m.t))}`);
			await Promise.race([
				new Promise((resolve) => waiters.push(resolve)),
				new Promise((resolve) => setTimeout(resolve, left)),
			]);
		}
	};
	return {
		ws,
		inbox,
		next,
		closed,
		send: (obj) => ws.send(encodeMessage(obj)),
		drop: () => ws.close(),
	};
}

const ctrlUrl = (server) => `ws://127.0.0.1:${server.controlPort}/mp/ws`;
const lanUrl = (server) => `ws://127.0.0.1:${server.lanPort}/mp/ws`;
const lanHttp = (server) => `http://127.0.0.1:${server.lanPort}`;
const ctrlHttp = (server) => `http://127.0.0.1:${server.controlPort}`;

async function hostAndMember(server, doc) {
	const host = await client(ctrlUrl(server));
	host.send({ t: "hello", proto: PROTO, role: "host", clientId: "host-1", name: "Host", open: { port: 0, doc, fileName: "song.ttml" } });
	const hw = await host.next("welcome");
	const member = await client(lanUrl(server));
	member.send({ t: "hello", proto: PROTO, role: "member", clientId: "member-1", name: "Ann" });
	const mw = await member.next("welcome");
	await host.next("member");
	return { host, hw, member, mw };
}

test("host opens LAN on random port and member joins over LAN", async (t) => {
	const server = await startServer(t);
	const doc = makeDoc(rng(31), 3);
	const { host, hw, member, mw } = await hostAndMember(server, doc);
	assert.equal(hw.you.host, true);
	assert.ok(hw.port > 0);
	assert.equal(server.lanPort, hw.port);
	assert.equal(mw.you.host, false);
	assert.equal(mw.seq, 0);
	assert.equal(mw.fileName, "song.ttml");
	assert.deepEqual(wire(mw.doc), wire(doc));
	assert.deepEqual(mw.members.map((m) => m.name).sort(), ["Ann", "Host"]);
	assert.ok(!JSON.stringify(mw).includes("host-1"), "client ids never reach others");
	const info = await (await fetch(`${lanHttp(server)}/mp/info`)).json();
	assert.equal(info.listener, "lan");
	assert.equal(info.lan.open, true);
	const ctrlInfo = await (await fetch(`${ctrlHttp(server)}/mp/info`)).json();
	assert.equal(ctrlInfo.listener, "control");
	host.drop();
	member.drop();
	await server.stop();
});

test("member cannot host over LAN", async (t) => {
	const server = await startServer(t);
	const { host } = await hostAndMember(server, makeDoc(rng(32), 1));
	const intruder = await client(lanUrl(server));
	intruder.send({ t: "hello", proto: PROTO, role: "host", clientId: "x", name: "X", open: { port: 0, doc: {} } });
	const err = await intruder.next("error");
	assert.equal(err.code, "not-allowed");
	host.drop();
	await server.stop();
});

test("protocol mismatch is refused", async (t) => {
	const server = await startServer(t);
	const { host } = await hostAndMember(server, makeDoc(rng(33), 1));
	const old = await client(lanUrl(server));
	old.send({ t: "hello", proto: PROTO + 1, role: "member", clientId: "o", name: "Old" });
	assert.equal((await old.next("error")).code, "version");
	host.drop();
	await server.stop();
});

test("ops ordered and echoed, late joiner gets snapshot", async (t) => {
	const server = await startServer(t);
	const r = rng(34);
	const doc = makeDoc(r, 4);
	const { host, member } = await hostAndMember(server, doc);
	const a = structuredClone(doc);
	a.lyricLines[0].translatedLyric = "host";
	const b = structuredClone(doc);
	b.lyricLines[2].translatedLyric = "member";
	host.send({ t: "ops", batch: 1, ops: diffDoc(doc, a) });
	member.send({ t: "ops", batch: 1, ops: diffDoc(doc, b) });
	const h1 = await host.next("ops");
	const h2 = await host.next("ops");
	const m1 = await member.next("ops");
	const m2 = await member.next("ops");
	assert.deepEqual([h1.seq, h2.seq], [1, 2]);
	assert.deepEqual([m1.from, m2.from], [h1.from, h2.from]);
	const late = await client(lanUrl(server));
	late.send({ t: "hello", proto: PROTO, role: "member", clientId: "late", name: "Late" });
	const lw = await late.next("welcome");
	assert.equal(lw.seq, 2);
	assert.equal(lw.doc.lyricLines[0].translatedLyric, "host");
	assert.equal(lw.doc.lyricLines[2].translatedLyric, "member");
	host.drop();
	member.drop();
	late.drop();
	await server.stop();
});

test("invalid ops are rejected", async (t) => {
	const server = await startServer(t);
	const { host } = await hostAndMember(server, makeDoc(rng(35), 1));
	host.send({ t: "ops", batch: 1, ops: [{ op: "boom" }] });
	const rej = await host.next("reject");
	assert.equal(rej.batch, 1);
	host.drop();
	await server.stop();
});

test("resume replays missed ops and dedupes resent batches", async (t) => {
	const server = await startServer(t);
	const r = rng(36);
	const doc = makeDoc(r, 3);
	const { host, member, mw } = await hostAndMember(server, doc);
	const mine = structuredClone(doc);
	mine.lyricLines[1].translatedLyric = "mine";
	const myOps = diffDoc(doc, mine);
	member.send({ t: "ops", batch: 1, ops: myOps });
	await host.next("ops");
	member.drop();
	await member.closed;
	const theirs = structuredClone(mine);
	theirs.lyricLines[0].translatedLyric = "theirs";
	host.send({ t: "ops", batch: 1, ops: diffDoc(mine, theirs) });
	await host.next("ops");
	const back = await client(lanUrl(server));
	back.send({
		t: "hello",
		proto: PROTO,
		role: "member",
		clientId: "member-1",
		name: "Ann",
		resume: { sessionId: mw.sessionId, seq: 0 },
	});
	const w = await back.next("welcome");
	assert.equal(w.resumed, true);
	assert.equal(w.lastBatch, 1);
	assert.equal(w.doc, undefined);
	assert.equal(w.you.id, mw.you.id);
	const r1 = await back.next("ops");
	const r2 = await back.next("ops");
	assert.deepEqual([r1.seq, r2.seq], [1, 2]);
	assert.equal(r1.from, mw.you.id);
	// the client resends its batch 1; the server must not apply it twice
	back.send({ t: "ops", batch: 1, ops: myOps });
	host.send({ t: "ops", batch: 2, ops: [{ op: "set", path: ["translationLanguage"], value: "en" }] });
	const n = await host.next("ops");
	assert.equal(n.seq, 3);
	host.drop();
	back.drop();
	await server.stop();
});

test("resume from too far back gets a snapshot", async (t) => {
	const server = await startServer(t);
	const { host, mw, member } = await hostAndMember(server, makeDoc(rng(37), 1));
	member.drop();
	await member.closed;
	const back = await client(lanUrl(server));
	back.send({
		t: "hello",
		proto: PROTO,
		role: "member",
		clientId: "member-1",
		name: "Ann",
		resume: { sessionId: "another-session", seq: 5 },
	});
	const w = await back.next("welcome");
	assert.equal(w.resumed, false);
	assert.ok(w.doc);
	host.drop();
	back.drop();
	await server.stop();
});

test("chat pin by anyone, delete own only, host deletes any", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(38), 1));
	host.send({ t: "chat", text: "from host", nonce: "n1" });
	const hm = (await member.next("chat")).message;
	await host.next("chat");
	member.send({ t: "chat", text: "from member  ", nonce: "n2" });
	const mm = (await host.next("chat")).message;
	await member.next("chat");
	assert.equal(mm.text, "from member");
	// member pins the host's message
	member.send({ t: "pin", id: hm.id, pinned: true });
	const up = await host.next("chatUpdate");
	assert.equal(up.pinned, true);
	// member cannot delete the host's message
	member.send({ t: "del", id: hm.id });
	assert.equal((await member.next("error")).code, "not-allowed");
	// member deletes own message
	member.send({ t: "del", id: mm.id });
	assert.equal((await host.next("chatDelete")).id, mm.id);
	assert.equal((await member.next("chatDelete")).id, mm.id);
	// host deletes any message
	host.send({ t: "del", id: hm.id });
	assert.equal((await member.next("chatDelete")).id, hm.id);
	// too long messages are refused
	member.send({ t: "chat", text: "x".repeat(LIMITS.messageChars + 1), nonce: "n3" });
	assert.equal((await member.next("error")).code, "too-long");
	host.drop();
	member.drop();
	await server.stop();
});

test("kick disconnects and broadcasts", async (t) => {
	const server = await startServer(t);
	const { host, member, mw } = await hostAndMember(server, makeDoc(rng(39), 1));
	member.send({ t: "kick", member: mw.members.find((m) => m.host).id });
	assert.equal((await member.next("error")).code, "not-allowed");
	host.send({ t: "kick", member: mw.you.id });
	await member.next("kicked");
	const closeInfo = await member.closed;
	assert.equal(closeInfo.code, 4001);
	const left = await host.next("left");
	assert.equal(left.reason, "kicked");
	assert.equal(left.id, mw.you.id);
	host.drop();
	await server.stop();
});

test("presence and leave are broadcast", async (t) => {
	const server = await startServer(t);
	const { host, member, mw } = await hostAndMember(server, makeDoc(rng(40), 1));
	member.send({ t: "presence", mode: "sync", line: 12, ping: 34 });
	const upd = await host.next("member");
	assert.equal(upd.member.mode, "sync");
	assert.equal(upd.member.line, 12);
	assert.equal(upd.member.ping, 34);
	member.send({ t: "leave" });
	const left = await host.next("left");
	assert.equal(left.reason, "left");
	assert.equal(left.id, mw.you.id);
	host.drop();
	await server.stop();
});

test("upload limits and safe headers", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(41), 1));
	const exact = new Uint8Array(LIMITS.chatFileBytes);
	const ok = await fetch(`${lanHttp(server)}/mp/upload?name=${encodeURIComponent("big file.bin")}`, {
		method: "POST",
		headers: { "X-MP-Client": "member-1", "Content-Type": "application/octet-stream" },
		body: exact,
	});
	assert.equal(ok.status, 200);
	const msg = (await host.next("chat")).message;
	assert.equal(msg.file.size, LIMITS.chatFileBytes);
	assert.equal(msg.file.name, "big file.bin");
	const tooBig = await fetch(`${lanHttp(server)}/mp/upload?name=x.bin`, {
		method: "POST",
		headers: { "X-MP-Client": "member-1" },
		body: new Uint8Array(LIMITS.chatFileBytes + 1),
	});
	assert.equal(tooBig.status, 413);
	const stranger = await fetch(`${lanHttp(server)}/mp/upload?name=x.bin`, {
		method: "POST",
		headers: { "X-MP-Client": "nobody" },
		body: new Uint8Array(10),
	});
	assert.equal(stranger.status, 403);
	// an html upload is never shown inline
	const html = await fetch(`${lanHttp(server)}/mp/upload?name=page.html`, {
		method: "POST",
		headers: { "X-MP-Client": "member-1", "Content-Type": "text/html" },
		body: "<script>alert(1)</script>",
	});
	const htmlMsg = (await html.json()).message;
	const got = await fetch(`${lanHttp(server)}${htmlMsg.file.url}`);
	assert.match(got.headers.get("content-disposition"), /^attachment/);
	assert.equal(got.headers.get("x-content-type-options"), "nosniff");
	assert.match(got.headers.get("content-security-policy"), /sandbox/);
	assert.equal(got.headers.get("cross-origin-resource-policy"), "cross-origin");
	assert.notEqual(got.headers.get("content-type"), "text/html");
	// a png is shown inline
	const png = await fetch(`${lanHttp(server)}/mp/upload?name=pic.png`, {
		method: "POST",
		headers: { "X-MP-Client": "host-1", "Content-Type": "image/png" },
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	});
	const pngMsg = (await png.json()).message;
	assert.equal(pngMsg.file.kind, "image");
	const pngGot = await fetch(`${ctrlHttp(server)}${pngMsg.file.url}`);
	assert.match(pngGot.headers.get("content-disposition"), /^inline/);
	assert.equal(pngGot.headers.get("content-type"), "image/png");
	assert.deepEqual([...new Uint8Array(await pngGot.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
	// preflight allows the client header from another origin
	const pre = await fetch(`${lanHttp(server)}/mp/upload`, {
		method: "OPTIONS",
		headers: { Origin: "http://localhost:47800", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-mp-client" },
	});
	assert.equal(pre.status, 204);
	assert.match(pre.headers.get("access-control-allow-headers"), /x-mp-client/i);
	host.drop();
	member.drop();
	await server.stop();
});

test("audio share host only and broadcast", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(42), 1));
	const audio = new Uint8Array(1024 * 1024).map((_, i) => i & 255);
	const denied = await fetch(`${lanHttp(server)}/mp/audio?name=song.flac`, {
		method: "POST",
		headers: { "X-MP-Client": "member-1" },
		body: audio,
	});
	assert.equal(denied.status, 403);
	const res = await fetch(`${ctrlHttp(server)}/mp/audio?name=${encodeURIComponent("песня.flac")}`, {
		method: "POST",
		headers: { "X-MP-Client": "host-1", "Content-Type": "audio/flac" },
		body: audio,
	});
	assert.equal(res.status, 200);
	const ev = await member.next("audio");
	assert.equal(ev.audio.name, "песня.flac");
	assert.equal(ev.audio.size, audio.length);
	const bytes = new Uint8Array(await (await fetch(`${lanHttp(server)}${ev.audio.url}`)).arrayBuffer());
	assert.deepEqual(bytes, audio);
	const late = await client(lanUrl(server));
	late.send({ t: "hello", proto: PROTO, role: "member", clientId: "late", name: "Late" });
	assert.equal((await late.next("welcome")).audio.id, ev.audio.id);
	host.drop();
	member.drop();
	late.drop();
	await server.stop();
});

test("close ends session for everyone", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(43), 1));
	const port = server.lanPort;
	member.send({ t: "close" });
	assert.equal((await member.next("error")).code, "not-allowed");
	host.send({ t: "close" });
	assert.equal((await member.next("closed")).reason, "host");
	await member.closed;
	await new Promise((resolve) => setTimeout(resolve, 100));
	await assert.rejects(fetch(`http://127.0.0.1:${port}/mp/info`));
	const info = await (await fetch(`${ctrlHttp(server)}/mp/info`)).json();
	assert.equal(info.lan.open, false);
	host.drop();
	await server.stop();
});

test("host reload resumes the same session", async (t) => {
	const server = await startServer(t);
	const doc = makeDoc(rng(44), 2);
	const { host, hw, member } = await hostAndMember(server, doc);
	host.drop();
	await host.closed;
	const again = await client(ctrlUrl(server));
	again.send({
		t: "hello",
		proto: PROTO,
		role: "host",
		clientId: "host-1",
		name: "Host",
		resume: { sessionId: hw.sessionId, seq: 0 },
		open: { port: 0, doc: makeDoc(rng(45), 5) },
	});
	const w = await again.next("welcome");
	assert.equal(w.sessionId, hw.sessionId);
	assert.equal(w.you.host, true);
	assert.equal(w.port, hw.port);
	member.drop();
	again.drop();
	await server.stop();
});

test("second host on the same machine is refused while the first is online", async (t) => {
	const server = await startServer(t);
	const { host } = await hostAndMember(server, makeDoc(rng(46), 1));
	const other = await client(ctrlUrl(server));
	other.send({ t: "hello", proto: PROTO, role: "host", clientId: "host-2", name: "H2", open: { port: 0, doc: {} } });
	assert.equal((await other.next("error")).code, "already-hosting");
	host.drop();
	await server.stop();
});

test("static app served with COOP/COEP and SPA fallback", async (t) => {
	const server = await startServer(t);
	const root = await fetch(`${ctrlHttp(server)}/`);
	assert.equal(root.status, 200);
	assert.match(await root.text(), /TTML Tool/);
	assert.equal(root.headers.get("cross-origin-opener-policy"), "same-origin");
	assert.equal(root.headers.get("cross-origin-embedder-policy"), "require-corp");
	const deep = await fetch(`${ctrlHttp(server)}/some/route`);
	assert.match(await deep.text(), /TTML Tool/);
	const js = await fetch(`${ctrlHttp(server)}/assets/app-123.js`);
	assert.match(js.headers.get("content-type"), /javascript/);
	const wasm = await fetch(`${ctrlHttp(server)}/decode-audio.wasm`);
	assert.equal(wasm.headers.get("content-type"), "application/wasm");
	const dict = await fetch(`${ctrlHttp(server)}/kuromoji-dict/base.dat.gz`);
	assert.equal(dict.headers.get("content-type"), "application/octet-stream");
	assert.equal(dict.headers.get("content-encoding"), null);
	const migration = await fetch(`${ctrlHttp(server)}/migration-send`);
	assert.equal(migration.headers.get("cross-origin-opener-policy"), "unsafe-none");
	const escape = await fetch(`${ctrlHttp(server)}/..%2f..%2fetc/passwd`);
	assert.doesNotMatch(await escape.text(), /root:/);
	await server.stop();
});

test("doc edits survive applyOps on the server", async (t) => {
	// The server's copy must match what clients compute.
	const server = await startServer(t);
	const r = rng(47);
	const doc = makeDoc(r, 5);
	const { host, member } = await hostAndMember(server, doc);
	let local = doc;
	for (let i = 0; i < 20; i++) {
		const next = structuredClone(local);
		next.lyricLines[i % 5].words[0].startTime = i * 10;
		host.send({ t: "ops", batch: i + 1, ops: diffDoc(local, next) });
		local = next;
	}
	let last;
	for (let i = 0; i < 20; i++) last = await member.next("ops");
	assert.equal(last.seq, 20);
	const late = await client(lanUrl(server));
	late.send({ t: "hello", proto: PROTO, role: "member", clientId: "z", name: "Z" });
	assert.deepEqual(wire((await late.next("welcome")).doc), wire(local));
	host.drop();
	member.drop();
	late.drop();
	await server.stop();
	assert.ok(applyOps);
});

test("media proxy only serves gif services", async (t) => {
	const server = await startServer(t);
	const refused = await fetch(`${ctrlHttp(server)}/mp/media?u=${encodeURIComponent("https://example.com/page")}`);
	assert.equal(refused.status, 400);
	const local = await fetch(`${ctrlHttp(server)}/mp/media?u=${encodeURIComponent("http://127.0.0.1:1/x.gif")}`);
	assert.equal(local.status, 400);
});

test("files of a closed session are gone", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(48), 1));
	const res = await fetch(`${ctrlHttp(server)}/mp/upload?name=a.png`, {
		method: "POST",
		headers: { "X-MP-Client": "host-1", "Content-Type": "image/png" },
		body: new Uint8Array([1, 2, 3]),
	});
	const { message } = await res.json();
	host.send({ t: "close" });
	await member.closed;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await fetch(`${ctrlHttp(server)}${message.file.url}`)).status, 404);
});

/** Status of a raw request (101 when a WebSocket upgrade is accepted). */
function rawStatus(port, { path = "/mp/ws", method = "GET", headers = {}, body } = {}) {
	const upgrade = path === "/mp/ws"
		? { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" }
		: {};
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers: { ...upgrade, ...headers } });
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve(101);
		});
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end(body);
	});
}

test("pages from other sites cannot use the server", async (t) => {
	const server = await startServer(t);
	const { host, member } = await hostAndMember(server, makeDoc(rng(41), 1));
	const evil = { Origin: "https://evil.example" };
	assert.equal(await rawStatus(server.controlPort, { headers: evil }), 403, "socket to the host's control port");
	assert.equal(await rawStatus(server.lanPort, { headers: evil }), 403, "socket to the network port");
	assert.equal(await rawStatus(server.controlPort, { headers: { Origin: "null" } }), 403, "sandboxed page");
	const rebound = { Host: `evil.example:${server.controlPort}`, Origin: `http://evil.example:${server.controlPort}` };
	assert.equal(await rawStatus(server.controlPort, { headers: rebound }), 403, "DNS rebinding");
	assert.equal(await rawStatus(server.controlPort, { path: "/mp/info", headers: { Host: "evil.example" } }), 403);
	const upload = { path: "/mp/upload?name=a.txt", method: "POST", body: "x" };
	assert.equal(await rawStatus(server.lanPort, { ...upload, headers: { ...evil, "X-MP-Client": "member-1" } }), 403);
	assert.equal(await rawStatus(server.controlPort, { path: "/mp/audio?name=a.mp3", method: "POST", body: "x", headers: { ...evil, "X-MP-Client": "host-1" } }), 403);
	// The editor's own pages, a dev server on localhost, and tools without an Origin still work.
	assert.equal(await rawStatus(server.controlPort, { headers: { Origin: `http://localhost:${server.controlPort}` } }), 101);
	assert.equal(await rawStatus(server.controlPort, { headers: { Origin: "http://localhost:5173" } }), 101);
	assert.equal(await rawStatus(server.lanPort, { headers: { Origin: `https://127.0.0.1:${server.lanPort}` } }), 101);
	assert.equal(await rawStatus(server.lanPort, { headers: { Origin: "http://localhost:47800" } }), 101);
	assert.equal(await rawStatus(server.lanPort, {}), 101);
	assert.equal(await rawStatus(server.lanPort, { ...upload, headers: { Origin: "http://localhost:47800", "X-MP-Client": "member-1" } }), 200);
	host.drop();
	member.drop();
});
