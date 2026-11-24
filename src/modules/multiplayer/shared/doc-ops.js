// Document operations shared by the multiplayer client and server.
//
// The editor keeps the lyrics as one immutable tree. diffDoc turns the
// difference between two versions into small operations that address arrays
// of lines, words, sections and metadata by their id (or key), not by index,
// so an edit still lands on the right item after someone else inserted a line
// above it. applyOps replays them with structural sharing: everything an
// operation does not touch keeps its identity, which keeps React renders cheap.
//
// Plain JavaScript so the Node server can import it without a build step.

/**
 * @typedef {string | { by: "id" | "key", v: string }} PathSeg
 * @typedef {"id" | "key"} KeyField
 * @typedef {{ op: "set", path: PathSeg[], value: unknown }} SetOp
 * @typedef {{ op: "del", path: PathSeg[] }} DelOp
 * @typedef {{ op: "ins", path: PathSeg[], by: KeyField, value: Record<string, unknown>, after: string | null, before: string | null }} InsOp
 * @typedef {{ op: "rm", path: PathSeg[], by: KeyField, key: string }} RmOp
 * @typedef {{ op: "mv", path: PathSeg[], by: KeyField, key: string, after: string | null, before: string | null }} MvOp
 * @typedef {SetOp | DelOp | InsOp | RmOp | MvOp} Op
 * @typedef {{
 *   isStale?: (value: object) => boolean,
 *   keepMissing?: (arrayPathKey: string, key: string) => boolean,
 * }} DiffOptions
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const KEY_FIELDS = /** @type {const} */ (["id", "key"]);
/** Arrays this big with nothing in common are replaced whole. */
const WHOLE_REPLACE_MIN = 8;
const MISSING = Symbol("missing");
const DELETE = Symbol("delete");
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * The field that identifies the elements of an array, if every element is an
 * object with a unique string `id` (preferred) or `key`.
 * @param {unknown} arr
 * @returns {KeyField | null}
 */
export function keyFieldOf(arr) {
	if (!Array.isArray(arr) || arr.length === 0) return null;
	for (const field of KEY_FIELDS) {
		const seen = new Set();
		let ok = true;
		for (const el of arr) {
			if (!isPlainObject(el) || typeof el[field] !== "string" || seen.has(el[field])) {
				ok = false;
				break;
			}
			seen.add(el[field]);
		}
		if (ok) return field;
	}
	return null;
}

/** @param {unknown[]} a @param {unknown[]} b @returns {KeyField | "empty" | null} */
function pairKeyField(a, b) {
	if (a.length === 0 && b.length === 0) return "empty";
	const ka = a.length === 0 ? null : keyFieldOf(a);
	const kb = b.length === 0 ? null : keyFieldOf(b);
	if (a.length === 0) return kb;
	if (b.length === 0) return ka;
	return ka !== null && ka === kb ? ka : null;
}

/** Structural equality where undefined properties count as absent and NaN equals NaN. */
export function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number") {
		return Number.isNaN(a) && Number.isNaN(b);
	}
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		for (const k of Object.keys(a)) {
			if (a[k] === undefined) continue;
			if (!deepEqual(a[k], b[k])) return false;
		}
		for (const k of Object.keys(b)) {
			if (b[k] !== undefined && (!hasOwn(a, k) || a[k] === undefined)) return false;
		}
		return true;
	}
	return false;
}

/** @param {PathSeg[]} path @returns {string} */
export function pathKey(path) {
	return path
		.map((seg) => (typeof seg === "string" ? seg : `${seg.by}=${seg.v}`))
		.join("\u0001");
}

/**
 * Operations that turn `a` into `b`.
 * @param {unknown} a
 * @param {unknown} b
 * @param {DiffOptions} [opts]
 * @returns {Op[]}
 */
export function diffDoc(a, b, opts = {}) {
	/** @type {Op[]} */
	const ops = [];
	diffValue(a, b, [], ops, opts);
	return ops;
}

/** @param {PathSeg[]} path @param {Op[]} ops @param {DiffOptions} opts */
function diffValue(a, b, path, ops, opts) {
	if (a === b) return;
	if (opts.isStale && b !== null && typeof b === "object" && opts.isStale(b)) return;
	if (isPlainObject(a) && isPlainObject(b)) {
		diffObject(a, b, path, ops, opts);
		return;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		const field = pairKeyField(a, b);
		if (field === "empty") return;
		if (field !== null) {
			diffKeyed(a, b, field, path, ops, opts);
			return;
		}
		if (!deepEqual(a, b)) ops.push({ op: "set", path, value: b });
		return;
	}
	if (deepEqual(a, b)) return;
	if (b === undefined) ops.push({ op: "del", path });
	else ops.push({ op: "set", path, value: b });
}

/** @param {Record<string, any>} a @param {Record<string, any>} b @param {PathSeg[]} path @param {Op[]} ops @param {DiffOptions} opts */
function diffObject(a, b, path, ops, opts) {
	for (const k of Object.keys(a)) {
		if (FORBIDDEN_KEYS.has(k) || a[k] === undefined) continue;
		if (!hasOwn(b, k) || b[k] === undefined) {
			ops.push({ op: "del", path: [...path, k] });
			continue;
		}
		diffValue(a[k], b[k], [...path, k], ops, opts);
	}
	for (const k of Object.keys(b)) {
		if (FORBIDDEN_KEYS.has(k) || b[k] === undefined) continue;
		if (hasOwn(a, k) && a[k] !== undefined) continue;
		ops.push({ op: "set", path: [...path, k], value: b[k] });
	}
}

/**
 * @param {Record<string, any>[]} a
 * @param {Record<string, any>[]} b
 * @param {KeyField} field
 * @param {PathSeg[]} path
 * @param {Op[]} ops
 * @param {DiffOptions} opts
 */
function diffKeyed(a, b, field, path, ops, opts) {
	// Fast path: same keys in the same order, only contents changed.
	if (a.length === b.length) {
		let sameOrder = true;
		for (let i = 0; i < a.length; i++) {
			if (a[i][field] !== b[i][field]) {
				sameOrder = false;
				break;
			}
		}
		if (sameOrder) {
			for (let i = 0; i < a.length; i++) {
				if (a[i] !== b[i]) {
					diffValue(a[i], b[i], [...path, { by: field, v: a[i][field] }], ops, opts);
				}
			}
			return;
		}
	}

	/** @type {Map<string, number>} */
	const aIndex = new Map();
	for (let i = 0; i < a.length; i++) aIndex.set(a[i][field], i);
	/** @type {Map<string, number>} */
	const bIndex = new Map();
	for (let i = 0; i < b.length; i++) bIndex.set(b[i][field], i);

	let shared = 0;
	for (const key of bIndex.keys()) if (aIndex.has(key)) shared++;
	if (
		shared === 0 &&
		a.length > 0 &&
		b.length > 0 &&
		a.length + b.length > WHOLE_REPLACE_MIN &&
		!(opts.isStale && b.some((el) => opts.isStale?.(el)))
	) {
		ops.push({ op: "set", path, value: b });
		return;
	}

	const arrayKey = opts.keepMissing ? pathKey(path) : "";
	for (const el of a) {
		const key = el[field];
		if (bIndex.has(key)) continue;
		if (opts.keepMissing?.(arrayKey, key)) continue;
		ops.push({ op: "rm", path, by: field, key });
	}

	for (const el of b) {
		const ai = aIndex.get(el[field]);
		if (ai === undefined || a[ai] === el) continue;
		diffValue(a[ai], el, [...path, { by: field, v: el[field] }], ops, opts);
	}

	const sharedKeys = [];
	for (const el of b) if (aIndex.has(el[field])) sharedKeys.push(el[field]);
	const stable = longestIncreasingKeys(sharedKeys, aIndex);

	/** @type {string | null} */
	let prev = null;
	for (let i = 0; i < b.length; i++) {
		const el = b[i];
		const key = el[field];
		const before = i + 1 < b.length ? b[i + 1][field] : null;
		if (!aIndex.has(key)) {
			// An element someone else removed, still present in a stale copy.
			if (opts.isStale?.(el)) continue;
			ops.push({ op: "ins", path, by: field, value: el, after: prev, before });
		} else if (!stable.has(key)) {
			ops.push({ op: "mv", path, by: field, key, after: prev, before });
		}
		prev = key;
	}
}

/**
 * Keys (in `keys` order) whose positions in `index` form a longest increasing
 * run; those stay put and everything else moves.
 * @param {string[]} keys
 * @param {Map<string, number>} index
 * @returns {Set<string>}
 */
function longestIncreasingKeys(keys, index) {
	const n = keys.length;
	const pos = keys.map((k) => /** @type {number} */ (index.get(k)));
	/** @type {number[]} */
	const tails = [];
	const tailIdx = [];
	const parent = new Array(n).fill(-1);
	for (let i = 0; i < n; i++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < pos[i]) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = pos[i];
		tailIdx[lo] = i;
		parent[i] = lo > 0 ? tailIdx[lo - 1] : -1;
	}
	const out = new Set();
	let i = tailIdx.length > 0 ? tailIdx[tailIdx.length - 1] : -1;
	while (i >= 0) {
		out.add(keys[i]);
		i = parent[i];
	}
	return out;
}

/**
 * Applies operations immutably. Operations whose target no longer exists are
 * skipped; nothing here throws on bad input.
 * @template T
 * @param {T} doc
 * @param {readonly Op[]} ops
 * @returns {T}
 */
export function applyOps(doc, ops) {
	/** @type {any} */
	let root = doc;
	for (const op of ops) {
		try {
			const next = applyOne(root, op);
			if (next !== MISSING) root = next;
		} catch {
			// A malformed operation changes nothing.
		}
	}
	return root;
}

/** @param {any} root @param {Op} op */
function applyOne(root, op) {
	switch (op.op) {
		case "set":
			if (op.path.length === 0) return op.value;
			return updateIn(root, op.path, 0, () => op.value);
		case "del":
			if (op.path.length === 0) return MISSING;
			return updateIn(root, op.path, 0, () => DELETE);
		case "ins":
			return updateIn(root, op.path, 0, (arr) => {
				if (!Array.isArray(arr) || !isPlainObject(op.value)) return MISSING;
				const key = op.value[op.by];
				const copy = arr.filter((el) => !(isPlainObject(el) && el[op.by] === key));
				copy.splice(anchorIndex(copy, op.by, op.after, op.before), 0, op.value);
				return copy;
			});
		case "rm":
			return updateIn(root, op.path, 0, (arr) => {
				if (!Array.isArray(arr)) return MISSING;
				const i = findIndexBy(arr, op.by, op.key);
				if (i < 0) return arr;
				const copy = arr.slice();
				copy.splice(i, 1);
				return copy;
			});
		case "mv":
			return updateIn(root, op.path, 0, (arr) => {
				if (!Array.isArray(arr)) return MISSING;
				const i = findIndexBy(arr, op.by, op.key);
				if (i < 0) return arr;
				const copy = arr.slice();
				const [el] = copy.splice(i, 1);
				copy.splice(anchorIndex(copy, op.by, op.after, op.before), 0, el);
				return copy;
			});
		default:
			return MISSING;
	}
}

/**
 * @param {any} node
 * @param {PathSeg[]} path
 * @param {number} i
 * @param {(current: any) => any} leaf
 * @returns {any}
 */
function updateIn(node, path, i, leaf) {
	if (i === path.length) return leaf(node);
	const seg = path[i];
	if (typeof seg === "string") {
		if (!isPlainObject(node) || FORBIDDEN_KEYS.has(seg)) return MISSING;
		const had = hasOwn(node, seg);
		const child = had ? node[seg] : undefined;
		const next = updateIn(child, path, i + 1, leaf);
		if (next === MISSING) return MISSING;
		if (next === DELETE) {
			if (!had) return node;
			const copy = { ...node };
			delete copy[seg];
			return copy;
		}
		if (had && next === child) return node;
		return { ...node, [seg]: next };
	}
	if (!Array.isArray(node) || !isPlainObject(seg)) return MISSING;
	const idx = findIndexBy(node, seg.by, seg.v);
	if (idx < 0) return MISSING;
	const child = node[idx];
	const next = updateIn(child, path, i + 1, leaf);
	if (next === MISSING) return MISSING;
	if (next === child) return node;
	const copy = node.slice();
	if (next === DELETE) copy.splice(idx, 1);
	else copy[idx] = next;
	return copy;
}

/** @param {any[]} arr @param {string} by @param {string} key */
function findIndexBy(arr, by, key) {
	for (let i = 0; i < arr.length; i++) {
		const el = arr[i];
		if (isPlainObject(el) && el[by] === key) return i;
	}
	return -1;
}

/** @param {any[]} arr @param {string} by @param {string | null} after @param {string | null} before */
function anchorIndex(arr, by, after, before) {
	if (after === null) return 0;
	const ai = findIndexBy(arr, by, after);
	if (ai >= 0) return ai + 1;
	if (before !== null) {
		const bi = findIndexBy(arr, by, before);
		if (bi >= 0) return bi;
	}
	return arr.length;
}

/** @param {unknown} seg */
function validSeg(seg) {
	if (typeof seg === "string") return seg.length <= 256 && !FORBIDDEN_KEYS.has(seg);
	return (
		isPlainObject(seg) &&
		(seg.by === "id" || seg.by === "key") &&
		typeof seg.v === "string" &&
		seg.v.length <= 256
	);
}

/** @param {unknown} v */
const validAnchor = (v) => v === null || (typeof v === "string" && v.length <= 256);

/**
 * Shape check for operations received from the network.
 * @param {unknown} ops
 * @param {{ maxOps?: number, maxDepth?: number }} [limits]
 * @returns {ops is Op[]}
 */
export function validateOps(ops, limits = {}) {
	const maxOps = limits.maxOps ?? 50000;
	const maxDepth = limits.maxDepth ?? 32;
	if (!Array.isArray(ops) || ops.length > maxOps) return false;
	for (const op of ops) {
		if (!isPlainObject(op) || !Array.isArray(op.path)) return false;
		if (op.path.length > maxDepth || !op.path.every(validSeg)) return false;
		switch (op.op) {
			case "set":
				if (!hasOwn(op, "value") || op.value === undefined) return false;
				break;
			case "del":
				if (op.path.length === 0) return false;
				break;
			case "ins":
				if (op.by !== "id" && op.by !== "key") return false;
				if (!isPlainObject(op.value) || typeof op.value[op.by] !== "string") return false;
				if (!validAnchor(op.after) || !validAnchor(op.before)) return false;
				break;
			case "rm":
				if (op.by !== "id" && op.by !== "key") return false;
				if (typeof op.key !== "string") return false;
				break;
			case "mv":
				if (op.by !== "id" && op.by !== "key") return false;
				if (typeof op.key !== "string") return false;
				if (!validAnchor(op.after) || !validAnchor(op.before)) return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

const NUMBER_TAG = "\u0000n";

/** JSON that keeps NaN and Infinity. @param {unknown} value @returns {string} */
export function encodeMessage(value) {
	return JSON.stringify(value, (_key, v) =>
		typeof v === "number" && !Number.isFinite(v) ? { [NUMBER_TAG]: String(v) } : v,
	);
}

/** @param {string} text @returns {any} */
export function decodeMessage(text) {
	return JSON.parse(text, (_key, v) => {
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			const keys = Object.keys(v);
			if (keys.length === 1 && keys[0] === NUMBER_TAG) return Number(v[NUMBER_TAG]);
		}
		return v;
	});
}
