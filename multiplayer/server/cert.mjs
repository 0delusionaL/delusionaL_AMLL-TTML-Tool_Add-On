// A self-signed certificate for the network port. Browsers only give a page
// the features the editor needs (crypto.randomUUID, AudioWorklet, clipboard)
// over HTTPS or on localhost, so friends who open the host's address in a
// browser get it over HTTPS. Browsers warn about the certificate once.
// Node has no API to make certificates, so this writes the DER by hand.

import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const FILE = "lan-certificate.json";
const NAME = "TTML Tool Multiplayer";

function length(n) {
	if (n < 0x80) return Buffer.from([n]);
	const bytes = [];
	for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x % 256);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const int = (bytes) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const octets = (bytes) => tlv(0x04, bytes);
const bits = (bytes) => tlv(0x03, Buffer.from([0]), bytes);
const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
function oid(text) {
	const [a, b, ...rest] = text.split(".").map(Number);
	const out = [40 * a + b];
	for (const v of rest) {
		const chunk = [v & 0x7f];
		for (let x = v >>> 7; x > 0; x >>>= 7) chunk.unshift((x & 0x7f) | 0x80);
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}
function time(date) {
	const iso = date.toISOString();
	const year = date.getUTCFullYear();
	const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
	return year < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}
const isIPv4 = (ip) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split(".").every((p) => Number(p) <= 255);

/**
 * @param {{ ips: string[], now?: Date, days?: number }} options
 * @returns {{ key: string, cert: string }} PEM private key and certificate
 */
export function createSelfSignedCert({ ips, now = new Date(), days = 365 }) {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
	const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(NAME)))));
	const serial = randomBytes(16);
	serial[0] = (serial[0] & 0x7f) | 0x01;
	const addresses = [...new Set(["127.0.0.1", ...ips.filter(isIPv4)])];
	const altNames = seq(
		tlv(0x82, Buffer.from("localhost")),
		...addresses.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
	);
	const extensions = seq(
		seq(oid("2.5.29.17"), octets(altNames)),
		seq(oid("2.5.29.15"), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))),
		seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))),
	);
	const tbs = seq(
		explicit(0, int(Buffer.from([2]))),
		int(serial),
		ecdsaSha256,
		name,
		seq(time(new Date(now.getTime() - 2 * DAY)), time(new Date(now.getTime() + days * DAY))),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		explicit(3, extensions),
	);
	const der = seq(tbs, ecdsaSha256, bits(sign("sha256", tbs, privateKey)));
	const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
	return {
		key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
		cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
	};
}

/**
 * The certificate saved in `dir`, or a new one when it is missing, about to
 * expire, or does not cover one of `ips`. Keeping it means friends' browsers
 * remember that they accepted it.
 * @param {string} dir @param {string[]} ips
 */
export function loadOrCreateCert(dir, ips) {
	const file = join(dir, FILE);
	try {
		const saved = JSON.parse(readFileSync(file, "utf8"));
		const x = new X509Certificate(saved.cert);
		const fresh = new Date(x.validTo).getTime() - Date.now() > 7 * DAY;
		const covers = ips.filter(isIPv4).every((ip) => x.checkIP(ip) !== undefined);
		if (fresh && covers && x.checkPrivateKey(createPrivateKey(saved.key))) {
			return { key: saved.key, cert: saved.cert };
		}
	} catch {
		// Missing or unreadable: make a new one.
	}
	const created = createSelfSignedCert({ ips });
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, JSON.stringify(created), { mode: 0o600 });
	} catch {
		// Still fine for this run; friends see the warning again next time.
	}
	return created;
}
