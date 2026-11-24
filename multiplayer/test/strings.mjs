import assert from "node:assert/strict";
import { test } from "node:test";
import { EN, STRINGS } from "../../src/modules/multiplayer/i18n/strings.ts";

const LOCALES = ["cs-CZ", "da-DK", "en-US", "es-ES", "fi-FI", "fr-FR", "id-ID", "it-IT", "nl-NL", "pl-PL", "pt-BR", "ro-RO", "ru-RU", "sk-SK", "tr-TR", "zh-CN"];
const vars = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every editor locale has a full table", () => {
	for (const code of LOCALES) {
		const table = STRINGS[code];
		assert.ok(table, `missing ${code}`);
		for (const key of Object.keys(EN)) {
			assert.equal(typeof table[key], "string", `${code}.${key} missing`);
			assert.deepEqual(vars(table[key]), vars(EN[key]), `${code}.${key} placeholders`);
		}
		assert.deepEqual(Object.keys(table).sort(), Object.keys(EN).sort(), `${code} has extra keys`);
	}
});

test("copy follows the editor's rules", () => {
	for (const [code, table] of Object.entries(STRINGS)) {
		for (const [key, text] of Object.entries(table)) {
			assert.ok(!text.includes("…"), `${code}.${key} uses the ellipsis character`);
			assert.ok(!text.includes("—"), `${code}.${key} uses an em dash`);
		}
	}
});
