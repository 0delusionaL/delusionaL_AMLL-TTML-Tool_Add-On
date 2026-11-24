// Links in chat messages: which ones show as images, and which GIF services
// the host fetches on everyone's behalf (their pages are not images, and the
// editor's cross-origin isolation blocks most images from other sites).

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const IMAGE_EXT = /\.(gif|png|jpe?g|webp|avif)$/;

/** Hosts whose files are images or GIFs the host may fetch. */
const MEDIA_HOSTS = new Set([
	"media.tenor.com",
	"media1.tenor.com",
	"c.tenor.com",
	"i.giphy.com",
	"media.giphy.com",
	"media0.giphy.com",
	"media1.giphy.com",
	"media2.giphy.com",
	"media3.giphy.com",
	"media4.giphy.com",
	"i.imgur.com",
	"cdn.discordapp.com",
	"media.discordapp.net",
]);
const TENOR_PAGES = new Set(["tenor.com", "www.tenor.com"]);
const GIPHY_PAGES = new Set(["giphy.com", "www.giphy.com"]);

/** @param {string} text @returns {{ url: string, start: number, end: number }[]} */
export function findLinks(text) {
	const out = [];
	for (const m of text.matchAll(URL_RE)) {
		const url = m[0].replace(/[),.!?;:]+$/, "");
		const start = m.index ?? 0;
		out.push({ url, start, end: start + url.length });
	}
	return out;
}

/** @param {string} url */
function parse(url) {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:" ? u : null;
	} catch {
		return null;
	}
}

/**
 * @param {string} url
 * @returns {{ kind: "image", proxy: boolean } | null}
 */
export function classifyLink(url) {
	const u = parse(url);
	if (!u) return null;
	const host = u.hostname.toLowerCase();
	const path = u.pathname.toLowerCase();
	if (TENOR_PAGES.has(host)) {
		return path.startsWith("/view/") || IMAGE_EXT.test(path)
			? { kind: "image", proxy: true }
			: null;
	}
	if (GIPHY_PAGES.has(host)) {
		return giphyMediaUrl(url) ? { kind: "image", proxy: true } : null;
	}
	if (MEDIA_HOSTS.has(host)) {
		return IMAGE_EXT.test(path) ? { kind: "image", proxy: true } : null;
	}
	return IMAGE_EXT.test(path) ? { kind: "image", proxy: false } : null;
}

/** Whether the host may fetch this URL (also checked after redirects). @param {string} url */
export function isProxyHost(url) {
	const u = parse(url);
	if (!u) return false;
	const host = u.hostname.toLowerCase();
	return MEDIA_HOSTS.has(host) || TENOR_PAGES.has(host) || GIPHY_PAGES.has(host);
}

/** @param {string} url @returns {string | null} */
export function giphyMediaUrl(url) {
	const u = parse(url);
	if (!u) return null;
	const host = u.hostname.toLowerCase();
	const parts = u.pathname.split("/").filter(Boolean);
	let id = null;
	if (GIPHY_PAGES.has(host) && parts[0] === "gifs" && parts[1]) {
		id = parts[1].split("-").pop() ?? null;
	} else if (/^media\d?\.giphy\.com$/.test(host) && parts[0] === "media" && parts[1]) {
		id = parts[1];
	} else if (host === "i.giphy.com" && parts[0]) {
		id = parts[0].replace(/\.(gif|webp)$/i, "");
	}
	return id && /^[A-Za-z0-9]+$/.test(id) ? `https://i.giphy.com/${id}.gif` : null;
}

/** The GIF a Tenor page shows. @param {string} html @returns {string | null} */
export function tenorMediaFromHtml(html) {
	const m1 = /https:\/\/media1\.tenor\.com\/m\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_%.-]+\.gif)/.exec(html);
	if (m1) return `https://media.tenor.com/${m1[1]}/${m1[2]}`;
	const m2 = /https:\/\/media\.tenor\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_%.-]+\.gif)/.exec(html);
	if (m2) return `https://media.tenor.com/${m2[1]}/${m2[2]}`;
	return null;
}

/** Tenor's media1 /m/ URLs answer browsers with a page; the plain host serves the file. @param {string} url */
export function directTenorUrl(url) {
	const u = parse(url);
	if (!u || u.hostname.toLowerCase() !== "media1.tenor.com") return url;
	const m = /^\/m\/([^/]+)\/(.+)$/.exec(u.pathname);
	return m ? `https://media.tenor.com/${m[1]}/${m[2]}` : url;
}
