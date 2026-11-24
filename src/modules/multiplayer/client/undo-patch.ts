// While in a party, Ctrl+Z and Ctrl+Y must only undo your own edits. The
// editor's undo works on whole-document snapshots, which would also roll back
// what friends did, so during a party its undo/redo atoms are pointed at the
// party's own history. Outside a party they behave exactly as before.

import type { Atom, Getter, Setter } from "jotai";
import { mpCanRedoAtom, mpCanUndoAtom, mpHistoryActiveAtom } from "../state";
import type { Upstream } from "./upstream";

const PATCHED = Symbol.for("ttml-tool.multiplayer.undo-patch");

let handlers: { undo: () => void; redo: () => void } | null = null;

type Patchable = { [PATCHED]?: boolean; read: (...args: never[]) => unknown; write?: (...args: never[]) => unknown };

function patchRead(target: unknown, replacement: Atom<boolean>) {
	const atom = target as Patchable | undefined;
	if (!atom || atom[PATCHED] || typeof atom.read !== "function") return;
	const original = atom.read as (this: unknown, get: Getter, options: unknown) => unknown;
	atom.read = function (this: unknown, get: Getter, options: unknown) {
		return get(mpHistoryActiveAtom) ? get(replacement) : original.call(this, get, options);
	} as Patchable["read"];
	atom[PATCHED] = true;
}

function patchWrite(target: unknown, run: () => void) {
	const atom = target as Patchable | undefined;
	if (!atom || atom[PATCHED] || typeof atom.write !== "function") return;
	const original = atom.write as (this: unknown, get: Getter, set: Setter, ...args: unknown[]) => unknown;
	atom.write = function (this: unknown, get: Getter, set: Setter, ...args: unknown[]) {
		if (get(mpHistoryActiveAtom)) {
			run();
			return undefined;
		}
		return original.call(this, get, set, ...args);
	} as Patchable["write"];
	atom[PATCHED] = true;
}

export function installUndoPatch(
	up: Upstream,
	next: { undo: () => void; redo: () => void },
) {
	handlers = next;
	patchRead(up.canUndoLyricLinesAtom, mpCanUndoAtom);
	patchRead(up.canRedoLyricLinesAtom, mpCanRedoAtom);
	patchWrite(up.undoLyricLinesAtom, () => handlers?.undo());
	patchWrite(up.redoLyricLinesAtom, () => handlers?.redo());
}
