// Shared helpers for the multiplayer node tests: a seeded RNG and a
// generator/mutator for TTML-shaped documents that copies like immer does
// (changed paths get new objects, everything else keeps its identity).

export function rng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n) => Math.floor(next() * n),
		pick: (arr) => arr[Math.floor(next() * arr.length)],
		chance: (p) => next() < p,
	};
}

// Ids are unique across processes and browser pages, like the editor's uid().
const idTag = Math.random().toString(36).slice(2, 7);
let idCounter = 0;
export const newId = (prefix = "i") => `${prefix}${idTag}${(idCounter++).toString(36)}`;

export function makeWord(r) {
	const start = r.int(100000);
	return {
		id: newId("w"),
		startTime: start,
		endTime: start + r.int(800),
		word: r.pick(["la", "love", "night", "you", "сон", "夜", " "]),
		obscene: false,
		romanWord: "",
	};
}

export function makeLine(r) {
	const words = Array.from({ length: 1 + r.int(5) }, () => makeWord(r));
	return {
		id: newId("l"),
		words,
		translatedLyric: "",
		romanLyric: "",
		isBG: false,
		isDuet: r.chance(0.2),
		startTime: words[0].startTime,
		endTime: words[words.length - 1].endTime,
		ignoreSync: false,
		isLineSynced: false,
		language: "auto",
	};
}

export function makeDoc(r, lines = 6) {
	return {
		metadata: [
			{ key: "musicName", value: ["Song"] },
			{ key: "artists", value: ["A", "B"] },
		],
		lyricLines: Array.from({ length: lines }, () => makeLine(r)),
		marks: [{ timeMs: 1000, label: "intro" }],
		sections: [{ id: newId("s"), label: "Verse 1", category: "verse" }],
	};
}

const setAt = (arr, i, value) => {
	const copy = arr.slice();
	copy[i] = value;
	return copy;
};

/** One random immutable edit, shaped like the editor's own edits. */
export function mutate(doc, r) {
	const lines = doc.lyricLines;
	const kind = r.int(14);
	if (lines.length === 0 && (kind < 9 || kind > 12)) {
		return { ...doc, lyricLines: [makeLine(r)] };
	}
	const li = r.int(Math.max(lines.length, 1));
	const line = lines[li];
	switch (kind) {
		case 0: {
			// word timing or text edit
			if (line.words.length === 0) return doc;
			const wi = r.int(line.words.length);
			const field = r.pick(["startTime", "endTime", "word", "romanWord"]);
			const value =
				field === "word" || field === "romanWord"
					? r.pick(["x", "yo", "ночь", ""])
					: r.int(200000);
			const words = setAt(line.words, wi, { ...line.words[wi], [field]: value });
			return { ...doc, lyricLines: setAt(lines, li, { ...line, words }) };
		}
		case 1: {
			// insert line
			const at = r.int(lines.length + 1);
			const copy = lines.slice();
			copy.splice(at, 0, makeLine(r));
			return { ...doc, lyricLines: copy };
		}
		case 2: {
			// delete line
			const copy = lines.slice();
			copy.splice(li, 1);
			return { ...doc, lyricLines: copy };
		}
		case 3: {
			// move line
			const copy = lines.slice();
			const [moved] = copy.splice(li, 1);
			copy.splice(r.int(copy.length + 1), 0, moved);
			return { ...doc, lyricLines: copy };
		}
		case 4: {
			// split a word into two new words
			if (line.words.length === 0) return doc;
			const wi = r.int(line.words.length);
			const w = line.words[wi];
			const words = line.words.slice();
			words.splice(
				wi,
				1,
				{ ...w, id: newId("w"), word: "a" },
				{ ...w, id: newId("w"), word: "b" },
			);
			return { ...doc, lyricLines: setAt(lines, li, { ...line, words }) };
		}
		case 5: {
			// merge two words
			if (line.words.length < 2) return doc;
			const wi = r.int(line.words.length - 1);
			const words = line.words.slice();
			const merged = {
				...words[wi],
				word: words[wi].word + words[wi + 1].word,
				endTime: words[wi + 1].endTime,
			};
			words.splice(wi, 2, merged);
			return { ...doc, lyricLines: setAt(lines, li, { ...line, words }) };
		}
		case 6: {
			// line field edit, sometimes removing an optional field
			const next = { ...line };
			if (r.chance(0.3)) next.translatedLyric = r.pick(["hi", "", "привет"]);
			else if (r.chance(0.5)) next.isBG = !line.isBG;
			else if ("sectionId" in line) delete next.sectionId;
			else next.sectionId = doc.sections?.[0]?.id ?? "none";
			return { ...doc, lyricLines: setAt(lines, li, next) };
		}
		case 7: {
			// reverse words of a line
			const words = line.words.slice().reverse();
			return { ...doc, lyricLines: setAt(lines, li, { ...line, words }) };
		}
		case 8: {
			// delete all words of a line
			return { ...doc, lyricLines: setAt(lines, li, { ...line, words: [] }) };
		}
		case 9: {
			// metadata value edit or add/remove a key
			const md = doc.metadata.slice();
			if (r.chance(0.5) && md.length > 0) {
				const mi = r.int(md.length);
				md[mi] = { ...md[mi], value: [...md[mi].value, "C"] };
			} else if (r.chance(0.5)) {
				md.push({ key: newId("k"), value: ["v"] });
			} else if (md.length > 0) {
				md.splice(r.int(md.length), 1);
			}
			return { ...doc, metadata: md };
		}
		case 10:
			return {
				...doc,
				marks: [...(doc.marks ?? []), { timeMs: r.int(9999), label: "m" }],
			};
		case 11: {
			const sections = (doc.sections ?? []).slice();
			if (r.chance(0.5)) {
				sections.push({ id: newId("s"), label: "Chorus", category: "chorus" });
			} else if (sections.length > 0) {
				sections.splice(r.int(sections.length), 1);
			}
			return { ...doc, sections };
		}
		case 12: {
			if ("translationLanguage" in doc) {
				const { translationLanguage: _, ...rest } = doc;
				return rest;
			}
			return { ...doc, translationLanguage: r.pick(["en", "ru"]) };
		}
		default: {
			// replace a whole line with a fresh copy (same id, new words)
			const fresh = makeLine(r);
			return {
				...doc,
				lyricLines: setAt(lines, li, { ...fresh, id: line.id }),
			};
		}
	}
}

export function mutateMany(doc, r, count) {
	let out = doc;
	for (let i = 0; i < count; i++) out = mutate(out, r);
	return out;
}

/** Wire-level form: what survives JSON, with undefined properties dropped. */
export const wire = (value) => JSON.parse(JSON.stringify(value));
