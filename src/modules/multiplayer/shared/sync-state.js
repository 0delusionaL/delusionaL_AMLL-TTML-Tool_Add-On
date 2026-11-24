// Client side of the document sync, without any I/O: the confirmed document
// (everything the server has ordered), the local batches the server has not
// confirmed yet, and the document the editor shows (confirmed + pending).
//
// This is the reconciliation loop of a networked game: local edits apply at
// once and are sent; edits from others arrive in server order and the local
// unconfirmed edits are re-applied on top, so every client ends up with the
// server's document.

import {
	applyOps,
	diffDoc,
	isPlainObject,
	keyFieldOf,
	pathKey,
} from "./doc-ops.js";

/**
 * @typedef {import("./doc-ops.js").Op} Op
 * @typedef {import("./doc-ops.js").PathSeg} PathSeg
 * @typedef {{ batch: number, ops: Op[] }} Batch
 * @typedef {{ seq: number, from: string, batch: number, ops: Op[] }} OrderedBatch
 */

/** Items a friend added this recently are never removed by a local write. */
const RECENT_INSERT_MS = 1500;
const MAX_TRACKED_INSERTS = 5000;
const SEP = "\u0002";

export class SyncState {
	/**
	 * @param {any} doc the server's document
	 * @param {number} seq the server sequence number of `doc`
	 * @param {number} [lastBatch] the last batch number the server saw from this client
	 */
	constructor(doc, seq, lastBatch = 0) {
		/** @type {any} */
		this.confirmed = doc;
		this.confirmedSeq = seq;
		/** @type {any} */
		this.displayed = doc;
		/** @type {Batch[]} */
		this.pending = [];
		this.nextBatch = lastBatch + 1;
		this.epoch = 0;
		/** Objects that a remote edit replaced, with the epoch it happened in. */
		this.supersededAt = new WeakMap();
		/** @type {Map<string, { epoch: number, time: number }>} */
		this.insertedAt = new Map();
	}

	/**
	 * A local edit: the editor now holds `next`.
	 * `display` is what the editor should hold afterwards; it differs from
	 * `next` only when `next` was built from an outdated document and would
	 * have undone a friend's edit.
	 * @param {any} next
	 * @param {{ trusted?: boolean }} [options] trusted: an undo or redo, never stale
	 * @returns {{ batch: Batch | null, display: any, undo: Op[] | null }}
	 */
	local(next, options = {}) {
		const prev = this.displayed;
		if (next === prev) return { batch: null, display: next, undo: null };
		if (options.trusted) {
			const ops = diffDoc(prev, next);
			this.displayed = next;
			if (ops.length === 0) return { batch: null, display: next, undo: null };
			/** @type {Batch} */
			const batch = { batch: this.nextBatch++, ops };
			this.pending.push(batch);
			return { batch, display: next, undo: diffDoc(next, prev) };
		}

		let staleEpoch = Number.POSITIVE_INFINITY;
		let adjusted = false;
		const isStale = (/** @type {object} */ obj) => {
			const epoch = this.supersededAt.get(obj);
			if (epoch === undefined) return false;
			if (epoch < staleEpoch) staleEpoch = epoch;
			adjusted = true;
			return true;
		};
		let ops = diffDoc(prev, next, { isStale });
		const now = Date.now();
		if (staleEpoch !== Number.POSITIVE_INFINITY || this.#hasRecentInserts(now)) {
			const keepMissing = (/** @type {string} */ arrayKey, /** @type {string} */ key) => {
				const info = this.insertedAt.get(arrayKey + SEP + key);
				if (!info) return false;
				const keep = info.epoch >= staleEpoch || now - info.time < RECENT_INSERT_MS;
				if (keep) adjusted = true;
				return keep;
			};
			ops = diffDoc(prev, next, { isStale, keepMissing });
		}

		const display = adjusted ? applyOps(prev, ops) : next;
		this.displayed = display;
		if (ops.length === 0) return { batch: null, display, undo: null };
		/** @type {Batch} */
		const batch = { batch: this.nextBatch++, ops };
		this.pending.push(batch);
		return { batch, display, undo: diffDoc(display, prev) };
	}

	/**
	 * An ordered batch from the server, ours or someone else's.
	 * @param {OrderedBatch} msg
	 * @param {string} myId
	 * @returns {{ display: any, gap: boolean, removed: boolean }}
	 */
	remote(msg, myId) {
		if (msg.seq !== this.confirmedSeq + 1) {
			return { display: null, gap: true, removed: false };
		}
		this.confirmed = applyOps(this.confirmed, msg.ops);
		this.confirmedSeq = msg.seq;
		if (msg.from === myId) {
			if (this.pending.length > 0 && this.pending[0].batch === msg.batch) {
				// Our own edit came back in the order we sent it: the screen
				// already shows it.
				this.pending.shift();
				return { display: null, gap: false, removed: false };
			}
			this.pending = this.pending.filter((p) => p.batch !== msg.batch);
		}
		const removed = msg.ops.some(
			(op) =>
				op.op === "rm" ||
				op.op === "del" ||
				(op.op === "set" && (op.path.length === 0 || Array.isArray(op.value))),
		);
		return { display: this.#rebuild(), gap: false, removed };
	}

	/**
	 * Start over from a server snapshot, keeping local batches the server
	 * has not applied yet.
	 * @param {any} doc
	 * @param {number} seq
	 * @param {number} lastBatch the last batch of ours the server applied
	 */
	reset(doc, seq, lastBatch) {
		this.confirmed = doc;
		this.confirmedSeq = seq;
		this.pending = this.pending.filter((p) => p.batch > lastBatch);
		this.nextBatch = Math.max(this.nextBatch, lastBatch + 1);
		return this.#rebuild();
	}

	/** Forget a batch the server refused. @param {number} batchNo */
	drop(batchNo) {
		this.pending = this.pending.filter((p) => p.batch !== batchNo);
		return this.#rebuild();
	}

	#rebuild() {
		let next = this.confirmed;
		for (const p of this.pending) next = applyOps(next, p.ops);
		this.epoch += 1;
		markChanges(this.displayed, next, [], this.epoch, Date.now(), this);
		this.displayed = next;
		this.#pruneInserts();
		return next;
	}

	/** @param {number} now */
	#hasRecentInserts(now) {
		for (const info of this.insertedAt.values()) {
			if (now - info.time < RECENT_INSERT_MS) return true;
		}
		return false;
	}

	#pruneInserts() {
		const extra = this.insertedAt.size - MAX_TRACKED_INSERTS;
		if (extra <= 0) return;
		let i = 0;
		for (const key of this.insertedAt.keys()) {
			if (i++ >= extra) break;
			this.insertedAt.delete(key);
		}
	}
}

/**
 * Records what a remote edit changed: the old objects on changed paths become
 * superseded and new keyed items are remembered as inserted.
 * @param {any} prev
 * @param {any} next
 * @param {PathSeg[]} path
 * @param {number} epoch
 * @param {number} now
 * @param {SyncState} state
 */
function markChanges(prev, next, path, epoch, now, state) {
	if (prev === next) return;
	if (prev !== null && typeof prev === "object") state.supersededAt.set(prev, epoch);
	if (isPlainObject(prev) && isPlainObject(next)) {
		for (const k of Object.keys(prev)) {
			markChanges(prev[k], next[k], [...path, k], epoch, now, state);
		}
		for (const k of Object.keys(next)) {
			if (!(k in prev)) markChanges(undefined, next[k], [...path, k], epoch, now, state);
		}
		return;
	}
	const field =
		Array.isArray(prev) || Array.isArray(next)
			? keyFieldOf(Array.isArray(prev) && prev.length > 0 ? prev : next)
			: null;
	if (field === null) return;
	const before = Array.isArray(prev) ? prev : [];
	const after = Array.isArray(next) ? next : [];
	/** @type {Map<string, any>} */
	const afterByKey = new Map();
	for (const el of after) if (isPlainObject(el)) afterByKey.set(el[field], el);
	const beforeKeys = new Set();
	for (const el of before) {
		if (!isPlainObject(el)) continue;
		beforeKeys.add(el[field]);
		const twin = afterByKey.get(el[field]);
		markChanges(el, twin, [...path, { by: field, v: el[field] }], epoch, now, state);
	}
	const arrayKey = pathKey(path);
	for (const [key] of afterByKey) {
		if (!beforeKeys.has(key)) state.insertedAt.set(arrayKey + SEP + key, { epoch, time: now });
	}
}
