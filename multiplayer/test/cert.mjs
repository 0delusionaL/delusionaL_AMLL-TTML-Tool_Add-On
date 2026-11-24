import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import { createSelfSignedCert, loadOrCreateCert } from "../server/cert.mjs";

const DAY = 24 * 60 * 60 * 1000;

test("a generated certificate covers the given addresses and localhost", () => {
	const { key, cert } = createSelfSignedCert({ ips: ["26.1.2.3", "192.168.1.5"] });
	const x = new X509Certificate(cert);
	assert.equal(x.checkIP("26.1.2.3"), "26.1.2.3");
	assert.equal(x.checkIP("192.168.1.5"), "192.168.1.5");
	assert.equal(x.checkIP("127.0.0.1"), "127.0.0.1");
	assert.equal(x.checkIP("26.9.9.9"), undefined);
	assert.equal(x.checkHost("localhost"), "localhost");
	assert.ok(x.checkPrivateKey(createPrivateKey(key)));
	assert.ok(x.verify(x.publicKey), "self-signed");
	const days = (new Date(x.validTo).getTime() - Date.now()) / DAY;
	assert.ok(days > 360 && days < 370, `valid for ${days} days`);
	assert.ok(new Date(x.validFrom).getTime() < Date.now() - DAY, "tolerates clocks behind");
});

test("TLS accepts the certificate", async (t) => {
	const { key, cert } = createSelfSignedCert({ ips: ["127.0.0.1"] });
	const server = tls.createServer({ key, cert }, (socket) => socket.end("hi"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const text = await new Promise((resolve, reject) => {
		const socket = tls.connect({ port: server.address().port, host: "127.0.0.1", ca: cert, servername: undefined });
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("end", () => resolve(data));
		socket.on("error", reject);
	});
	assert.equal(text, "hi");
});

test("the saved certificate is reused until an address is new", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mp-cert-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const first = loadOrCreateCert(dir, ["26.1.2.3"]);
	const again = loadOrCreateCert(dir, ["26.1.2.3"]);
	assert.equal(again.cert, first.cert);
	const grown = loadOrCreateCert(dir, ["26.1.2.3", "10.0.0.7"]);
	assert.notEqual(grown.cert, first.cert);
	assert.equal(new X509Certificate(grown.cert).checkIP("10.0.0.7"), "10.0.0.7");
	assert.equal(loadOrCreateCert(dir, ["10.0.0.7"]).cert, grown.cert);
	const [file] = ["lan-certificate.json"].map((name) => join(dir, name));
	writeFileSync(file, "{ broken");
	const repaired = loadOrCreateCert(dir, ["26.1.2.3"]);
	assert.ok(new X509Certificate(repaired.cert).checkIP("26.1.2.3"));
	assert.equal(JSON.parse(readFileSync(file, "utf8")).cert, repaired.cert);
});

test("an unwritable folder still gives a working certificate", () => {
	const { cert } = loadOrCreateCert(join(tmpdir(), "mp-cert-missing", "\u0000bad"), ["26.1.2.3"]);
	assert.ok(new X509Certificate(cert).checkIP("26.1.2.3"));
});
