// Serves the built editor (dist/) with the same headers as the official site
// (public/_headers): cross-origin isolation everywhere except the data
// migration pages, and the Japanese dictionary as raw bytes.

import { createReadStream, promises as fsp } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".gz": "application/octet-stream",
	".dat": "application/octet-stream",
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>TTML Tool</title>
<body style="font-family:system-ui;background:#1b1a20;color:#eee;padding:40px">
<h1>Сборка не найдена</h1><p>Запусти <b>Multiplayer.bat</b>: он соберёт редактор и откроет его.</p>
<p>The editor is not built yet. Run <b>Multiplayer.bat</b>.</p></body>`;

/** @param {string} pathname */
function headersFor(pathname) {
	/** @type {Record<string, string>} */
	const h = { "X-Content-Type-Options": "nosniff" };
	if (pathname.startsWith("/migration-")) {
		h["Cross-Origin-Opener-Policy"] = "unsafe-none";
		h["Cross-Origin-Embedder-Policy"] = "unsafe-none";
		h["Cache-Control"] = "no-store";
	} else {
		h["Cross-Origin-Opener-Policy"] = "same-origin";
		h["Cross-Origin-Embedder-Policy"] = "require-corp";
	}
	if (pathname.startsWith("/kuromoji-dict/")) {
		h["Content-Type"] = "application/octet-stream";
		h["Cache-Control"] = "public, max-age=2592000";
	} else if (pathname.startsWith("/assets/")) {
		h["Cache-Control"] = "public, max-age=31536000, immutable";
	}
	return h;
}

/** @param {string} file */
async function isFile(file) {
	try {
		return (await fsp.stat(file)).isFile();
	} catch {
		return false;
	}
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} distDir
 * @param {URL} url
 */
export async function serveStatic(req, res, distDir, url) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { Allow: "GET, HEAD" }).end();
		return;
	}
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const root = resolve(distDir);
	const index = join(root, "index.html");
	if (!(await isFile(index))) {
		res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" }).end(NOT_BUILT);
		return;
	}
	let file = resolve(root, `.${pathname.includes("\0") ? "/" : pathname}`);
	const inside = file === root || file.startsWith(root + sep);
	if (!inside) file = index;
	else if (!(await isFile(file))) {
		const dirIndex = join(file, "index.html");
		if (await isFile(dirIndex)) file = dirIndex;
		else if (extname(pathname) === "" || pathname.startsWith("/migration-")) file = index;
		else {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
			return;
		}
	}
	const headers = headersFor(pathname);
	const ext = extname(file).toLowerCase();
	if (!headers["Content-Type"]) {
		headers["Content-Type"] =
			MIME[/** @type {keyof typeof MIME} */ (ext)] ?? "application/octet-stream";
	}
	if (ext === ".html") headers["Cache-Control"] = "no-cache";
	const { size } = await fsp.stat(file);
	headers["Content-Length"] = String(size);
	res.writeHead(200, headers);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(file).on("error", () => res.destroy()).pipe(res);
}
