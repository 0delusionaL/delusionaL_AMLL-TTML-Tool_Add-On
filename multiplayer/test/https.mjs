// The network port speaks both plain HTTP (own-copy members) and HTTPS with a
// self-signed certificate (friends who open the address in a browser).

// Test-only: accept the server's self-signed certificate in fetch and WebSocket.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import tls from "node:tls";
import { decodeMessage, diffDoc, encodeMessage } from "../../src/modules/multiplayer/shared/doc-ops.js";
import { PROTO } from "../../src/modules/multiplayer/shared/protocol.js";
import { createMultiplayerServer } from "../server/app.mjs";
import { makeDoc, rng } from "./helpers.mjs";

let dir;
let dist;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "mp-https-"));
	dist = mkdtempSync(join(dir, "dist-"));
	writeFileSync(join(dist, "index.html"), "<!doctype html><title>TTML Tool</title>");
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function startServer(t, certDir = join(dir, "certs")) {
	const server = createMultiplayerServer({ distDir: dist, controlPort: 0, log: () => {}, certDir });
	await server.start();
	t.after(() => server.stop());
	return server;
}

function socketClient(url) {
	const ws = new WebSocket(url);
	const inbox = [];
	ws.onmessage = (e) => inbox.push(decodeMessage(e.data));
	const opened = new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
	});
	const next = async (type, ms = 3000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const i = inbox.findIndex((m) => m.t === type);
			if (i >= 0) return inbox.splice(i, 1)[0];
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`timeout waiting for ${type}: ${JSON.stringify(inbox.map((m) => m.t))}`);
	};
	return { ws, opened, next, send: (obj) => ws.send(encodeMessage(obj)) };
}

async function openNetwork(server) {
	const host = socketClient(`ws://127.0.0.1:${server.controlPort}/mp/ws`);
	await host.opened;
	host.send({ t: "hello", proto: PROTO, role: "host", clientId: "host-1", name: "Host", open: { port: 0, doc: makeDoc(rng(7), 2) } });
	const welcome = await host.next("welcome");
	return { host, welcome };
}

const peerFingerprint = (port) =>
	new Promise((resolve, reject) => {
		const socket = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
			resolve(socket.getPeerCertificate().fingerprint256);
			socket.end();
		});
		socket.on("error", reject);
	});

test("the network port answers plain HTTP and HTTPS on the same port", async (t) => {
	const server = await startServer(t);
	const { host, welcome } = await openNetwork(server);
	assert.equal(welcome.https, true);
	const plain = await (await fetch(`http://127.0.0.1:${server.lanPort}/mp/info`)).json();
	const secure = await (await fetch(`https://127.0.0.1:${server.lanPort}/mp/info`)).json();
	assert.equal(plain.listener, "lan");
	assert.equal(secure.listener, "lan");
	assert.equal(secure.lan.https, true);
	const page = await fetch(`https://127.0.0.1:${server.lanPort}/`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /TTML Tool/);
	assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
	host.ws.close();
});

test("browser page loads over plain HTTP on the network port go to HTTPS", async (t) => {
	const server = await startServer(t);
	const { host } = await openNetwork(server);
	const base = `http://127.0.0.1:${server.lanPort}`;
	const root = await fetch(`${base}/`, { redirect: "manual" });
	assert.equal(root.status, 302);
	assert.equal(root.headers.get("location"), `https://127.0.0.1:${server.lanPort}/`);
	const deep = await fetch(`${base}/editor?x=1`, { redirect: "manual" });
	assert.equal(deep.headers.get("location"), `https://127.0.0.1:${server.lanPort}/editor?x=1`);
	assert.equal((await fetch(`${base}/mp/info`, { redirect: "manual" })).status, 200);
	const control = await fetch(`http://127.0.0.1:${server.controlPort}/`, { redirect: "manual" });
	assert.equal(control.status, 200, "the host's own page stays on http://localhost");
	host.ws.close();
});

test("members join over wss and ws on the same port and see each other's edits", async (t) => {
	const server = await startServer(t);
	const { host } = await openNetwork(server);
	const browserFriend = socketClient(`wss://127.0.0.1:${server.lanPort}/mp/ws`);
	const ownCopy = socketClient(`ws://127.0.0.1:${server.lanPort}/mp/ws`);
	await Promise.all([browserFriend.opened, ownCopy.opened]);
	browserFriend.send({ t: "hello", proto: PROTO, role: "member", clientId: "b-1", name: "Browser" });
	ownCopy.send({ t: "hello", proto: PROTO, role: "member", clientId: "c-1", name: "Copy" });
	const bw = await browserFriend.next("welcome");
	await ownCopy.next("welcome");
	const edited = structuredClone(bw.doc);
	edited.lyricLines[0].translatedLyric = "from the browser";
	const ops = diffDoc(bw.doc, edited);
	browserFriend.send({ t: "ops", batch: 1, ops });
	const seen = await ownCopy.next("ops");
	assert.deepEqual(seen.ops, ops);
	for (const c of [host, browserFriend, ownCopy]) c.ws.close();
});

test("kept-alive connections serve several requests either way", async (t) => {
	const server = await startServer(t);
	const { host } = await openNetwork(server);
	const get = (lib, agent, path) =>
		new Promise((resolve, reject) => {
			lib.get({ host: "127.0.0.1", port: server.lanPort, path, agent, rejectUnauthorized: false }, (res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode));
			}).on("error", reject);
		});
	const plainAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
	const tlsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
	t.after(() => {
		plainAgent.destroy();
		tlsAgent.destroy();
	});
	for (let i = 0; i < 3; i++) assert.equal(await get(http, plainAgent, "/mp/info"), 200);
	for (let i = 0; i < 3; i++) assert.equal(await get(https, tlsAgent, "/"), 200);
	host.ws.close();
});

test("the certificate is kept between runs", async (t) => {
	const certDir = join(dir, "kept");
	const first = await startServer(t, certDir);
	const a = await openNetwork(first);
	const before = await peerFingerprint(first.lanPort);
	a.host.ws.close();
	await first.stop();
	const second = await startServer(t, certDir);
	const b = await openNetwork(second);
	assert.equal(await peerFingerprint(second.lanPort), before);
	b.host.ws.close();
});
