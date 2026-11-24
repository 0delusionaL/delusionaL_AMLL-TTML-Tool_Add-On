import { useTranslation } from "react-i18next";
import type { MpT } from "../i18n/useMpT";
import type { MpMember, MpMode } from "../state";

/** Radix colour scales players are told apart by. */
export const MEMBER_COLORS = [
	"tomato",
	"blue",
	"grass",
	"amber",
	"violet",
	"cyan",
	"pink",
	"orange",
	"teal",
	"indigo",
	"lime",
	"plum",
];

export const memberColor = (index: number) =>
	`var(--${MEMBER_COLORS[Math.abs(index) % MEMBER_COLORS.length]}-9)`;

export function modeLabel(mode: MpMode | null, t: MpT) {
	switch (mode) {
		case "edit":
			return t("modeEdit");
		case "sync":
			return t("modeSync");
		case "preview":
			return t("modePreview");
		case "chat":
			return t("modeChat");
		default:
			return null;
	}
}

/** "Time, line 12 · 34 ms" */
export function presenceText(member: MpMember, t: MpT) {
	if (!member.online) return t("offline");
	const parts: string[] = [];
	const mode = modeLabel(member.mode, t);
	if (mode) parts.push(member.line ? `${mode}, ${t("lineN", { n: member.line })}` : mode);
	if (member.ping !== null) parts.push(t("pingMs", { ms: member.ping }));
	return parts.join(" · ");
}

export function formatBytes(size: number, t: MpT) {
	if (size < 1024) return t("bytesB", { n: size });
	if (size < 1024 * 1024) return t("bytesKB", { n: Math.round(size / 1024) });
	return t("bytesMB", { n: (size / (1024 * 1024)).toFixed(1) });
}

export function useLanguage() {
	const { i18n } = useTranslation();
	return i18n.resolvedLanguage ?? i18n.language ?? "en-US";
}

export function formatTime(at: number, language: string) {
	try {
		return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
			new Date(at),
		);
	} catch {
		return new Date(at).toLocaleTimeString();
	}
}

export async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

/** Keys typed in multiplayer UI never reach the editor's shortcuts. */
export function stopEditorKeys(event: { key: string; stopPropagation: () => void }) {
	if (event.key !== "Escape") event.stopPropagation();
}
