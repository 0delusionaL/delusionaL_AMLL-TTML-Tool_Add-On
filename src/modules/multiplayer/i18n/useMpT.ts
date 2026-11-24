// Multiplayer keeps its own strings so the editor's translation catalogs (and
// their frequent changes) stay untouched. The language follows the editor.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { EN, type MpKey, STRINGS } from "./strings";

export type MpT = (key: MpKey, vars?: Record<string, string | number>) => string;

export function tableFor(language: string | undefined): Partial<Record<MpKey, string>> {
	if (!language) return EN;
	const exact = STRINGS[language];
	if (exact) return exact;
	const base = language.split("-")[0].toLowerCase();
	const match = Object.keys(STRINGS).find((code) => code.split("-")[0].toLowerCase() === base);
	return match ? STRINGS[match] : EN;
}

export function format(text: string, vars?: Record<string, string | number>) {
	if (!vars) return text;
	return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
		name in vars ? String(vars[name]) : whole,
	);
}

export function translate(language: string | undefined): MpT {
	const table = tableFor(language);
	return (key, vars) => format(table[key] ?? EN[key], vars);
}

export function useMpT(): MpT {
	const { i18n } = useTranslation();
	const language = i18n.resolvedLanguage ?? i18n.language;
	return useMemo(() => translate(language), [language]);
}
