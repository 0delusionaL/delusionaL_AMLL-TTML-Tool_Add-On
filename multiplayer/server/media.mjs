// Fetches GIFs from Tenor, Giphy, Imgur and Discord for the chat, so a GIF
// link shows as an animation for everyone. Only those services are reachable
// through here, so the host's PC can't be used to fetch anything else.

import {
	classifyLink,
	directTenorUrl,
	giphyMediaUrl,
	isProxyHost,
	tenorMediaFromHtml,
} from "../../src/modules/multiplayer/shared/media-links.js";

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/**
 * @param {Response} response
 * @param {number} limit
 */
async function readLimited(response, limit) {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > limit) throw new Error("too large");
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const parts = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new Error("too large");
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

/** @param {{ fetchImpl?: typeof fetch }} [options] */
export function createMediaProxy(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	/** @type {Map<string, { type: string, body: Buffer }>} */
	const cache = new Map();
	let cached = 0;

	/** @param {string} url @param {number} limit */
	async function get(url, limit) {
		const response = await fetchImpl(url, {
			redirect: "follow",
			headers: { "User-Agent": UA, Accept: "image/*,text/html;q=0.8,*/*;q=0.5" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`status ${response.status}`);
		if (response.url && !isProxyHost(response.url)) throw new Error("redirected elsewhere");
		return { response, body: await readLimited(response, limit) };
	}

	/** @param {string} link */
	async function resolveMedia(link) {
		const host = new URL(link).hostname.toLowerCase();
		if (host === "tenor.com" || host === "www.tenor.com") {
			if (/\.gif$/i.test(new URL(link).pathname)) return link;
			const { body } = await get(link, MAX_PAGE_BYTES);
			const media = tenorMediaFromHtml(body.toString("utf8"));
			if (!media) throw new Error("no gif on page");
			return media;
		}
		if (host === "giphy.com" || host === "www.giphy.com") {
			const media = giphyMediaUrl(link);
			if (!media) throw new Error("not a gif page");
			return media;
		}
		return directTenorUrl(link);
	}

	/**
	 * @param {import("node:http").ServerResponse} res
	 * @param {URL} url
	 */
	return async function handleMedia(res, url) {
		const link = url.searchParams.get("u") ?? "";
		const kind = classifyLink(link);
		if (!kind?.proxy) {
			res.writeHead(400, { "Access-Control-Allow-Origin": "*" }).end();
			return;
		}
		try {
			let entry = cache.get(link);
			if (!entry) {
				const target = await resolveMedia(link);
				const { response, body } = await get(target, MAX_MEDIA_BYTES);
				const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
				if (!type.startsWith("image/") || type === "image/svg+xml") throw new Error("not an image");
				entry = { type, body };
				cache.set(link, entry);
				cached += body.length;
				for (const [key, value] of cache) {
					if (cached <= CACHE_BYTES) break;
					cache.delete(key);
					cached -= value.body.length;
				}
			}
			res.writeHead(200, {
				"Content-Type": entry.type,
				"Content-Length": String(entry.body.length),
				"Cache-Control": "public, max-age=86400",
				"Cross-Origin-Resource-Policy": "cross-origin",
				"Access-Control-Allow-Origin": "*",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(entry.body);
		} catch {
			res.writeHead(502, { "Access-Control-Allow-Origin": "*" }).end();
		}
	};
}
