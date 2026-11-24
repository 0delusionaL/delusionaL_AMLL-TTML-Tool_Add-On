import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyOps,
	decodeMessage,
	diffDoc,
	encodeMessage,
	keyFieldOf,
	validateOps,
} from "../../src/modules/multiplayer/shared/doc-ops.js";
import { makeDoc, makeLine, mutate, mutateMany, rng, wire } from "./helpers.mjs";

test("round trip on random edits", () => {
	const r = rng(1);
	for (let i = 0; i < 2000; i++) {
		const a = makeDoc(r, r.int(12));
		const b = mutateMany(a, r, 1 + r.int(6));
		const ops = diffDoc(a, b);
		const c = applyOps(a, ops);
		assert.deepEqual(wire(c), wire(b), `case ${i}: ${JSON.stringify(ops)}`);
		// the ops themselves survive the wire
		const c2 = applyOps(a, decodeMessage(encodeMessage(ops)));
		assert.deepEqual(wire(c2), wire(b), `case ${i} over the wire`);
	}
});

test("diff of identical docs is empty", () => {
	const r = rng(2);
	const a = makeDoc(r);
	assert.deepEqual(diffDoc(a, a), []);
	assert.deepEqual(diffDoc(a, wire(a)), []);
});

test("untouched subtrees keep identity", () => {
	const r = rng(3);
	const a = makeDoc(r, 8);
	const line = a.lyricLines[3];
	const words = line.words.slice();
	words[0] = { ...words[0], startTime: 42 };
	const b = {
		...a,
		lyricLines: a.lyricLines.map((l, i) => (i === 3 ? { ...line, words } : l)),
	};
	const c = applyOps(a, diffDoc(a, b));
	for (let i = 0; i < 8; i++) {
		if (i === 3) continue;
		assert.equal(c.lyricLines[i], a.lyricLines[i]);
	}
	assert.equal(c.metadata, a.metadata);
	assert.equal(c.lyricLines[3].words[1], a.lyricLines[3].words[1]);
	assert.equal(c.lyricLines[3].words[0].startTime, 42);
});

test("applying ops never mutates the input", () => {
	const r = rng(4);
	for (let i = 0; i < 200; i++) {
		const a = makeDoc(r, 5);
		const snapshot = JSON.stringify(a);
		const b = mutateMany(a, r, 4);
		applyOps(a, diffDoc(a, b));
		assert.equal(JSON.stringify(a), snapshot);
	}
});

test("concurrent word edits in one line merge", () => {
	const r = rng(5);
	const base = makeDoc(r, 3);
	const line = base.lyricLines[1];
	assert.ok(line.words.length >= 1);
	// client 1 times the first word, client 2 retypes the last word
	const w0 = line.words[0];
	const wl = line.words[line.words.length - 1];
	const b1 = structuredClone(base);
	b1.lyricLines[1].words[0].startTime = 777;
	const b2 = structuredClone(base);
	b2.lyricLines[1].words[line.words.length - 1].word = "merged";
	const server = applyOps(applyOps(base, diffDoc(base, b1)), diffDoc(base, b2));
	const words = server.lyricLines[1].words;
	assert.equal(words.find((w) => w.id === w0.id).startTime, 777);
	assert.equal(words.find((w) => w.id === wl.id).word, "merged");
});

test("concurrent inserts both survive", () => {
	const r = rng(6);
	const base = makeDoc(r, 3);
	const x = makeLine(r);
	const y = makeLine(r);
	const b1 = { ...base, lyricLines: [...base.lyricLines.slice(0, 1), x, ...base.lyricLines.slice(1)] };
	const b2 = { ...base, lyricLines: [...base.lyricLines.slice(0, 1), y, ...base.lyricLines.slice(1)] };
	const server = applyOps(applyOps(base, diffDoc(base, b1)), diffDoc(base, b2));
	const ids = server.lyricLines.map((l) => l.id);
	assert.equal(ids.length, 5);
	assert.ok(ids.includes(x.id) && ids.includes(y.id));
	assert.equal(new Set(ids).size, 5);
});

test("insert anchors survive neighbour deletion", () => {
	const r = rng(7);
	const base = makeDoc(r, 3);
	const [A, B, C] = base.lyricLines;
	const X = makeLine(r);
	const insert = diffDoc(base, { ...base, lyricLines: [A, B, X, C] });
	const remove = diffDoc(base, { ...base, lyricLines: [A, C] });
	const server = applyOps(applyOps(base, remove), insert);
	assert.deepEqual(
		server.lyricLines.map((l) => l.id),
		[A.id, X.id, C.id],
	);
});

test("edit of a line deleted concurrently is dropped", () => {
	const r = rng(8);
	const base = makeDoc(r, 3);
	const edited = structuredClone(base);
	edited.lyricLines[1].translatedLyric = "late edit";
	const removed = { ...base, lyricLines: [base.lyricLines[0], base.lyricLines[2]] };
	const server = applyOps(applyOps(base, diffDoc(base, removed)), diffDoc(base, edited));
	assert.equal(server.lyricLines.length, 2);
	assert.ok(!server.lyricLines.some((l) => l.translatedLyric === "late edit"));
});

test("whole array replaced when no keys are shared", () => {
	const r = rng(9);
	const a = makeDoc(r, 30);
	const b = { ...a, lyricLines: Array.from({ length: 30 }, () => makeLine(r)) };
	const ops = diffDoc(a, b);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].op, "set");
	assert.deepEqual(ops[0].path, ["lyricLines"]);
});

test("moves keep order and identity", () => {
	const r = rng(10);
	const a = makeDoc(r, 10);
	const lines = a.lyricLines.slice();
	const [moved] = lines.splice(7, 1);
	lines.splice(1, 0, moved);
	const b = { ...a, lyricLines: lines };
	const ops = diffDoc(a, b);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].op, "mv");
	const c = applyOps(a, ops);
	assert.deepEqual(
		c.lyricLines.map((l) => l.id),
		b.lyricLines.map((l) => l.id),
	);
	assert.equal(c.lyricLines[1], moved);
});

test("metadata is keyed by key", () => {
	const r = rng(11);
	const a = makeDoc(r, 1);
	assert.equal(keyFieldOf(a.metadata), "key");
	assert.equal(keyFieldOf(a.lyricLines), "id");
	assert.equal(keyFieldOf([{ timeMs: 1 }]), null);
	assert.equal(keyFieldOf([{ id: "a" }, { id: "a" }]), null);
	const b = { ...a, metadata: [a.metadata[0], { ...a.metadata[1], value: ["Z"] }] };
	const ops = diffDoc(a, b);
	assert.deepEqual(ops, [
		{ op: "set", path: ["metadata", { by: "key", v: "artists" }, "value"], value: ["Z"] },
	]);
});

test("removed optional field travels as del", () => {
	const r = rng(12);
	const a = { ...makeDoc(r, 1), translationLanguage: "en" };
	const { translationLanguage: _, ...b } = a;
	const ops = diffDoc(a, b);
	assert.deepEqual(ops, [{ op: "del", path: ["translationLanguage"] }]);
	assert.ok(!("translationLanguage" in applyOps(a, ops)));
});

test("root replace sets the whole document", () => {
	const r = rng(13);
	const a = makeDoc(r, 2);
	const b = makeDoc(r, 2);
	const c = applyOps(a, [{ op: "set", path: [], value: b }]);
	assert.deepEqual(wire(c), wire(b));
});

test("unresolvable ops are skipped, not thrown", () => {
	const r = rng(14);
	const a = makeDoc(r, 2);
	const c = applyOps(a, [
		{ op: "set", path: ["lyricLines", { by: "id", v: "missing" }, "startTime"], value: 1 },
		{ op: "rm", path: ["lyricLines"], by: "id", key: "missing" },
		{ op: "mv", path: ["lyricLines"], by: "id", key: "missing", after: null, before: null },
		{ op: "set", path: ["metadata", "notAnObjectKey", "x"], value: 1 },
		{ op: "ins", path: ["nope", "deeper"], by: "id", value: { id: "z" }, after: null, before: null },
	]);
	assert.deepEqual(wire(c), wire(a));
});

test("NaN survives encode/decode", () => {
	const out = decodeMessage(
		encodeMessage({ x: Number.NaN, y: Infinity, z: -Infinity, n: 1.5, s: "ok" }),
	);
	assert.ok(Number.isNaN(out.x));
	assert.equal(out.y, Infinity);
	assert.equal(out.z, -Infinity);
	assert.equal(out.n, 1.5);
	assert.equal(out.s, "ok");
});

test("validateOps rejects malformed", () => {
	assert.equal(validateOps([]), true);
	assert.equal(validateOps([{ op: "set", path: ["a", { by: "id", v: "x" }], value: 1 }]), true);
	assert.equal(validateOps("nope"), false);
	assert.equal(validateOps([{ op: "boom", path: [] }]), false);
	assert.equal(validateOps([{ op: "set", path: [{ by: "other", v: "x" }], value: 1 }]), false);
	assert.equal(validateOps([{ op: "set", path: [5], value: 1 }]), false);
	assert.equal(validateOps([{ op: "ins", path: ["a"], by: "id", value: 3, after: null, before: null }]), false);
	assert.equal(validateOps([{ op: "rm", path: ["a"], by: "id" }]), false);
	assert.equal(validateOps([{ op: "set", path: ["__proto__", "x"], value: 1 }]), false);
	assert.equal(validateOps(new Array(5).fill({ op: "del", path: ["a"] }), { maxOps: 4 }), false);
});

test("prototype keys are never written", () => {
	const doc = { a: 1 };
	const out = applyOps(doc, [{ op: "set", path: ["__proto__", "polluted"], value: true }]);
	assert.equal({}.polluted, undefined);
	assert.equal(out.polluted, undefined);
});

test("diff and apply stay fast on a large document", () => {
	const r = rng(15);
	const a = makeDoc(r, 3000);
	let b = a;
	const t0 = performance.now();
	for (let i = 0; i < 200; i++) {
		const next = mutate(b, r);
		const ops = diffDoc(b, next);
		b = applyOps(b, ops);
	}
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 2000, `200 edits on 3000 lines took ${elapsed} ms`);
});
