// The editor state multiplayer reads and writes, reached through namespace
// imports and checked at runtime. If a future version of the editor renames
// one of these, multiplayer reports itself incompatible instead of breaking
// the build or the editor.

import type { Atom, WritableAtom } from "jotai";
import * as useLoadAudioModule from "$/hooks/useLoadAudio";
import * as audioStates from "$/modules/audio/states";
import * as mainState from "$/states/main";

// biome-ignore lint/suspicious/noExplicitAny: values come from modules that may change shape
export type AnyWritable = WritableAtom<any, any[], any>;
// biome-ignore lint/suspicious/noExplicitAny: see above
export type AnyAtom = Atom<any>;

function pick<T>(mod: unknown, name: string): T | undefined {
	const value = (mod as Record<string, unknown>)[name];
	if (
		value &&
		typeof value === "object" &&
		typeof (value as { read?: unknown }).read === "function"
	) {
		return value as T;
	}
	return undefined;
}

export type LoadAudioHook = () => { openAudioFile?: (file: File) => unknown };

function collect() {
	const loadAudio = (useLoadAudioModule as unknown as Record<string, unknown>)
		.useLoadAudio;
	return {
		lyricLinesAtom: pick<AnyWritable>(mainState, "lyricLinesAtom"),
		toolModeAtom: pick<AnyWritable>(mainState, "toolModeAtom"),
		selectedLinesAtom: pick<AnyWritable>(mainState, "selectedLinesAtom"),
		selectedWordsAtom: pick<AnyWritable>(mainState, "selectedWordsAtom"),
		projectIdAtom: pick<AnyWritable>(mainState, "projectIdAtom"),
		saveFileNameAtom: pick<AnyWritable>(mainState, "saveFileNameAtom"),
		isDirtyAtom: pick<AnyAtom>(mainState, "isDirtyAtom"),
		startFreshLyricDocumentAtom: pick<AnyWritable>(
			mainState,
			"startFreshLyricDocumentAtom",
		),
		undoLyricLinesAtom: pick<AnyWritable>(mainState, "undoLyricLinesAtom"),
		redoLyricLinesAtom: pick<AnyWritable>(mainState, "redoLyricLinesAtom"),
		canUndoLyricLinesAtom: pick<AnyAtom>(mainState, "canUndoLyricLinesAtom"),
		canRedoLyricLinesAtom: pick<AnyAtom>(mainState, "canRedoLyricLinesAtom"),
		loadedAudioAtom: pick<AnyAtom>(audioStates, "loadedAudioAtom"),
		useLoadAudio:
			typeof loadAudio === "function" ? (loadAudio as LoadAudioHook) : undefined,
	};
}

export type Upstream = ReturnType<typeof collect>;

let cached: Upstream | null = null;

/** Read on first use, after the editor's modules have loaded. */
export function getUpstream(): Upstream {
	cached ??= collect();
	return cached;
}

/** Names of missing parts; the first group stops multiplayer entirely. */
export function missingParts() {
	const up = getUpstream();
	const required = (["lyricLinesAtom"] as const).filter((name) => !up[name]);
	const optional = (Object.keys(up) as (keyof Upstream)[]).filter(
		(name) => name !== "lyricLinesAtom" && !up[name],
	);
	return { required, optional };
}
