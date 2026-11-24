// Files sent during a party: chat attachments and the host's audio. They live
// in a temporary folder until the network closes.

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * @typedef {{
 *   id: string, name: string, size: number, mime: string,
 *   kind: "image" | "audio" | "video" | "file", path: string,
 *   purpose: "chat" | "audio", createdAt: number,
 * }} StoredFile
 */

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const EXT_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	mp3: "audio/mpeg",
	flac: "audio/flac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	mp4: "video/mp4",
	webm: "video/webm",
	ttml: "application/ttml+xml",
	txt: "text/plain",
	lrc: "text/plain",
	json: "application/json",
};

/** @param {unknown} name */
export function cleanFileName(name, maxChars = 120) {
	const raw = typeof name === "string" ? name : "";
	const base = raw.split(/[\\/]/).pop() ?? "";
	const clean = Array.from(base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim())
		.slice(0, maxChars)
		.join("")
		.replace(/^\.+/, "");
	return clean || "file";
}

/** @param {string} name @param {unknown} declared */
export function fileType(name, declared) {
	const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
	const fromName = EXT_TYPES[/** @type {keyof typeof EXT_TYPES} */ (ext)];
	const declaredType =
		typeof declared === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(declared.split(";")[0].trim())
			? declared.split(";")[0].trim().toLowerCase()
			: "";
	const mime = fromName ?? (declaredType || "application/octet-stream");
	/** @type {StoredFile["kind"]} */
	const kind = IMAGE_TYPES.has(mime)
		? "image"
		: mime.startsWith("audio/")
			? "audio"
			: mime.startsWith("video/")
				? "video"
				: "file";
	return { mime, kind };
}

export class FileStore {
	/** @param {{ root?: string }} [options] */
	constructor(options = {}) {
		this.root = options.root ?? tmpdir();
		/** @type {string | null} */
		this.dir = null;
		/** @type {Map<string, StoredFile>} */
		this.files = new Map();
	}

	async #ensureDir() {
		if (!this.dir) this.dir = await fsp.mkdtemp(join(this.root, "ttml-mp-"));
		return this.dir;
	}

	/**
	 * Streams `source` to disk. Rejects with code "too-large" past `limit`.
	 * @param {NodeJS.ReadableStream} source
	 * @param {{ name: string, declaredType?: unknown, limit: number, purpose: "chat" | "audio" }} info
	 * @returns {Promise<StoredFile>}
	 */
	async put(source, info) {
		const dir = await this.#ensureDir();
		const id = randomBytes(16).toString("hex");
		const path = join(dir, id);
		let size = 0;
		const counter = new Transform({
			transform(chunk, _enc, done) {
				size += chunk.length;
				if (size > info.limit) {
					done(Object.assign(new Error("too large"), { code: "too-large" }));
				} else {
					done(null, chunk);
				}
			},
		});
		try {
			await pipeline(source, counter, createWriteStream(path));
		} catch (error) {
			await fsp.rm(path, { force: true });
			throw error;
		}
		const name = cleanFileName(info.name);
		const { mime, kind } = fileType(name, info.declaredType);
		/** @type {StoredFile} */
		const meta = { id, name, size, mime, kind, path, purpose: info.purpose, createdAt: Date.now() };
		this.files.set(id, meta);
		return meta;
	}

	/** @param {string} id */
	get(id) {
		return this.files.get(id);
	}

	/** @param {string} id */
	async remove(id) {
		const meta = this.files.get(id);
		if (!meta) return;
		this.files.delete(id);
		await fsp.rm(meta.path, { force: true });
	}

	/** @param {"chat" | "audio"} purpose */
	bytes(purpose) {
		let total = 0;
		for (const f of this.files.values()) if (f.purpose === purpose) total += f.size;
		return total;
	}

	/** @param {StoredFile} meta */
	open(meta) {
		return createReadStream(meta.path);
	}

	async clear() {
		this.files.clear();
		if (this.dir) {
			const dir = this.dir;
			this.dir = null;
			await fsp.rm(dir, { recursive: true, force: true });
		}
	}
}
