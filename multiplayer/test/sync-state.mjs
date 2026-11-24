import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, diffDoc } from "../../src/modules/multiplayer/shared/doc-ops.js";
import { SyncState } from "../../src/modules/multiplayer/shared/sync-state.js";
import { makeDoc, makeLine, mutate, rng, wire } from "./helpers.mjs";

/** A tiny in-process server: applies batches in arrival order. */
function makeServer(doc) {
	const server = { doc, seq: 0 };
	server.accept = (from, batch) => {
		server.doc = applyOps(server.doc, batch.ops);
		server.seq += 1;
		return { seq: server.seq, from, batch: batch.batch, ops: batch.ops };
	};
	return server;
}

test("own echo needs no display change", () => {
	const r = rng(21);
	const base = makeDoc(r, 4);
	const state = new SyncState(base, 0);
	const server = makeServer(base);
	const next = mutate(base, r);
	const { batch, display } = state.local(next);
	assert.ok(batch);
	assert.equal(display, next);
	const echo = server.accept("me", batch);
	const res = state.remote(echo, "me");
	assert.equal(res.display, null);
	assert.equal(res.gap, false);
	assert.equal(state.pending.length, 0);
	assert.deepEqual(wire(state.confirmed), wire(next));
});

test("rebase keeps pending local ops", () => {
	const r = rng(22);
	const base = makeDoc(r, 4);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	// my unconfirmed edit: retime word 0 of line 0
	const mine = structuredClone(base);
	mine.lyricLines[0].words[0].startTime = 1111;
	const { batch } = me.local(mine);
	// someone else's edit reaches the server first: new text in line 3
	const theirs = structuredClone(base);
	theirs.lyricLines[3].translatedLyric = "their text";
	const otherBatch = { batch: 1, ops: diffDoc(base, theirs) };
	const res = me.remote(server.accept("other", otherBatch), "me");
	assert.ok(res.display);
	assert.equal(res.display.lyricLines[0].words[0].startTime, 1111);
	assert.equal(res.display.lyricLines[3].translatedLyric, "their text");
	assert.equal(me.pending.length, 1);
	// then my echo arrives and nothing needs to change on screen
	const echo = me.remote(server.accept("me", batch), "me");
	assert.equal(echo.display, null);
	assert.deepEqual(wire(me.displayed), wire(server.doc));
});

test("three clients converge under random interleavings", () => {
	for (let round = 0; round < 60; round++) {
		const r = rng(1000 + round);
		const base = makeDoc(r, 1 + r.int(8));
		const server = makeServer(base);
		const clients = ["a", "b", "c"].map((id) => ({
			id,
			state: new SyncState(base, 0),
			editor: base,
			out: [],
			inbox: [],
		}));
		const steps = 150;
		for (let s = 0; s < steps; s++) {
			const c = r.pick(clients);
			const action = r.int(3);
			if (action === 0) {
				const next = mutate(c.editor, r);
				const res = c.state.local(next);
				c.editor = res.display;
				if (res.batch) c.out.push(res.batch);
			} else if (action === 1 && c.out.length > 0) {
				const msg = server.accept(c.id, c.out.shift());
				for (const other of clients) other.inbox.push(msg);
			} else if (c.inbox.length > 0) {
				const res = c.state.remote(c.inbox.shift(), c.id);
				assert.equal(res.gap, false);
				if (res.display) c.editor = res.display;
			}
			assert.equal(c.editor, c.state.displayed);
		}
		// drain
		let moved = true;
		while (moved) {
			moved = false;
			for (const c of clients) {
				while (c.out.length > 0) {
					const msg = server.accept(c.id, c.out.shift());
					for (const other of clients) other.inbox.push(msg);
					moved = true;
				}
			}
			for (const c of clients) {
				while (c.inbox.length > 0) {
					const res = c.state.remote(c.inbox.shift(), c.id);
					if (res.display) c.editor = res.display;
					moved = true;
				}
			}
		}
		for (const c of clients) {
			assert.equal(c.state.pending.length, 0, `round ${round} ${c.id} pending`);
			assert.deepEqual(wire(c.editor), wire(server.doc), `round ${round} client ${c.id}`);
		}
	}
});

test("stale write keeps remote changes", () => {
	const r = rng(23);
	const base = makeDoc(r, 6);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	// a friend retimes line 2
	const friend = structuredClone(base);
	friend.lyricLines[2].words[0].startTime = 4242;
	const msg = server.accept("friend", { batch: 1, ops: diffDoc(base, friend) });
	const shown = me.remote(msg, "me").display;
	assert.equal(shown.lyricLines[2].words[0].startTime, 4242);
	// the editor then writes a result computed from the old document (base):
	// it edits line 5 and keeps the old line 2 object
	const lines = base.lyricLines.slice();
	lines[5] = { ...lines[5], translatedLyric: "local" };
	const stale = { ...base, lyricLines: lines };
	const res = me.local(stale);
	assert.ok(res.batch);
	assert.notEqual(res.display, stale);
	assert.equal(res.display.lyricLines[2].words[0].startTime, 4242);
	assert.equal(res.display.lyricLines[5].translatedLyric, "local");
	const after = applyOps(server.doc, res.batch.ops);
	assert.equal(after.lyricLines[2].words[0].startTime, 4242);
	assert.equal(after.lyricLines[5].translatedLyric, "local");
});

test("stale write does not delete a line a friend just added", () => {
	const r = rng(24);
	const base = makeDoc(r, 4);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	const x = makeLine(r);
	const friend = { ...base, lyricLines: [...base.lyricLines, x] };
	me.remote(server.accept("friend", { batch: 1, ops: diffDoc(base, friend) }), "me");
	// stale result: built from base, so it has no x
	const lines = base.lyricLines.slice();
	lines[0] = { ...lines[0], isBG: !lines[0].isBG };
	const res = me.local({ ...base, lyricLines: lines });
	assert.ok(res.display.lyricLines.some((l) => l.id === x.id));
	assert.ok(!res.batch.ops.some((op) => op.op === "rm"));
});

test("reset drops already applied batches", () => {
	const r = rng(25);
	const base = makeDoc(r, 3);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	const first = me.local(mutate(base, r));
	const second = me.local(mutate(me.displayed, r));
	assert.ok(first.batch && second.batch);
	// the server applied only the first batch before the connection dropped
	server.accept("me", first.batch);
	const shown = me.reset(server.doc, server.seq, first.batch.batch);
	assert.equal(me.pending.length, 1);
	assert.equal(me.pending[0].batch, second.batch.batch);
	assert.deepEqual(wire(shown), wire(applyOps(server.doc, second.batch.ops)));
	// new batches continue after the last number the server saw
	assert.ok(me.local(mutate(me.displayed, r)).batch.batch > second.batch.batch);
});

test("next batch number continues after the server's last batch", () => {
	const r = rng(26);
	const base = makeDoc(r, 2);
	const me = new SyncState(base, 5, 17);
	assert.equal(me.local(mutate(base, r)).batch.batch, 18);
});

test("gap in sequence is reported", () => {
	const r = rng(27);
	const base = makeDoc(r, 2);
	const me = new SyncState(base, 0);
	const res = me.remote({ seq: 2, from: "x", batch: 1, ops: [] }, "me");
	assert.equal(res.gap, true);
	assert.equal(me.confirmedSeq, 0);
});

test("undo entry inverts only own change", () => {
	const r = rng(28);
	const base = makeDoc(r, 4);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	const mine = structuredClone(base);
	mine.lyricLines[1].translatedLyric = "mine";
	const res = me.local(mine);
	assert.ok(res.undo && res.undo.length > 0);
	me.remote(server.accept("me", res.batch), "me");
	// a friend edits another line afterwards
	const friendDoc = structuredClone(server.doc);
	friendDoc.lyricLines[3].translatedLyric = "friend";
	me.remote(server.accept("friend", { batch: 1, ops: diffDoc(server.doc, friendDoc) }), "me");
	// undoing my change keeps the friend's line
	const undone = applyOps(me.displayed, res.undo);
	assert.equal(undone.lyricLines[1].translatedLyric, base.lyricLines[1].translatedLyric);
	assert.equal(undone.lyricLines[3].translatedLyric, "friend");
});

test("dropping a rejected batch restores the confirmed view", () => {
	const r = rng(29);
	const base = makeDoc(r, 3);
	const me = new SyncState(base, 0);
	const res = me.local(mutate(base, r));
	const shown = me.drop(res.batch.batch);
	assert.equal(me.pending.length, 0);
	assert.deepEqual(wire(shown), wire(base));
});

test("trusted local changes skip stale protection", () => {
	const r = rng(30);
	const base = makeDoc(r, 3);
	const me = new SyncState(base, 0);
	const server = makeServer(base);
	const friend = structuredClone(base);
	friend.lyricLines[1].translatedLyric = "friend";
	me.remote(server.accept("friend", { batch: 1, ops: diffDoc(base, friend) }), "me");
	// an undo that deliberately restores the old line object
	const restored = {
		...me.displayed,
		lyricLines: me.displayed.lyricLines.map((l, i) => (i === 1 ? base.lyricLines[1] : l)),
	};
	const untrusted = new SyncState(me.confirmed, me.confirmedSeq);
	assert.ok(me.local(restored, { trusted: true }).batch);
	assert.equal(me.displayed, restored);
	assert.ok(untrusted);
});
