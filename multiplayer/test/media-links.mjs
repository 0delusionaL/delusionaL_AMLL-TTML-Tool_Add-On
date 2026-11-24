import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyLink,
	findLinks,
	giphyMediaUrl,
	tenorMediaFromHtml,
} from "../../src/modules/multiplayer/shared/media-links.js";
import { normalizeName, parseAddress } from "../../src/modules/multiplayer/shared/protocol.js";

test("finds links in text", () => {
	const links = findLinks("look https://tenor.com/view/cat-gif-123 and http://x.y/a.png, ok");
	assert.deepEqual(
		links.map((l) => l.url),
		["https://tenor.com/view/cat-gif-123", "http://x.y/a.png"],
	);
	assert.equal(findLinks("no links here").length, 0);
});

test("classifies gif hosts and image links", () => {
	assert.deepEqual(classifyLink("https://media.tenor.com/abc/cat.gif"), { kind: "image", proxy: true });
	assert.deepEqual(classifyLink("https://tenor.com/view/cat-dance-gif-123456"), { kind: "image", proxy: true });
	assert.deepEqual(classifyLink("https://giphy.com/gifs/happy-cat-l0HlBO7eyXzSZkJri"), { kind: "image", proxy: true });
	assert.deepEqual(classifyLink("https://i.imgur.com/x1.gif"), { kind: "image", proxy: true });
	assert.deepEqual(classifyLink("https://cdn.discordapp.com/attachments/1/2/a.gif"), { kind: "image", proxy: true });
	assert.deepEqual(classifyLink("https://example.com/pic.webp?x=1"), { kind: "image", proxy: false });
	assert.equal(classifyLink("https://example.com/page"), null);
	assert.equal(classifyLink("javascript:alert(1)"), null);
	assert.equal(classifyLink("http://evil.example/x.gif.html"), null);
});

test("giphy page links become media links", () => {
	assert.equal(
		giphyMediaUrl("https://giphy.com/gifs/happy-cat-l0HlBO7eyXzSZkJri"),
		"https://i.giphy.com/l0HlBO7eyXzSZkJri.gif",
	);
	assert.equal(
		giphyMediaUrl("https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif"),
		"https://i.giphy.com/l0HlBO7eyXzSZkJri.gif",
	);
	assert.equal(giphyMediaUrl("https://giphy.com/explore/cats"), null);
});

test("tenor pages yield their gif", () => {
	const html =
		'<meta property="og:image" content="https://media1.tenor.com/m/AbC123_x/cat-dance.gif"><img src="https://media.tenor.com/zz/other.gif">';
	assert.equal(tenorMediaFromHtml(html), "https://media.tenor.com/AbC123_x/cat-dance.gif");
	assert.equal(tenorMediaFromHtml("<html></html>"), null);
});

test("addresses parse like Minecraft direct connect", () => {
	assert.deepEqual(parseAddress("26.12.34.56:51234"), { host: "26.12.34.56", port: 51234 });
	assert.deepEqual(parseAddress(" http://26.12.34.56:51234/ "), { host: "26.12.34.56", port: 51234 });
	assert.deepEqual(parseAddress("localhost:47800"), { host: "localhost", port: 47800 });
	assert.equal(parseAddress("26.12.34.56"), null);
	assert.equal(parseAddress("26.12.34.56:99999"), null);
	assert.equal(parseAddress("bad host:1"), null);
});

test("names are trimmed and limited", () => {
	assert.equal(normalizeName("  Ann \n  Lee  "), "Ann Lee");
	assert.equal(normalizeName("x".repeat(50)).length, 32);
	assert.equal(normalizeName("   "), "");
	assert.equal(normalizeName("a\u0000b"), "ab");
});
