import { atom } from "jotai";

export type MpPhase = "idle" | "connecting" | "connected" | "reconnecting";
export type MpRole = "host" | "member";
export type MpMode = "edit" | "sync" | "preview" | "chat";

export interface MpMember {
	id: string;
	name: string;
	color: number;
	host: boolean;
	online: boolean;
	mode: MpMode | null;
	line: number | null;
	ping: number | null;
}

export interface MpFile {
	id: string;
	name: string;
	size: number;
	mime: string;
	kind: "image" | "audio" | "video" | "file";
	url: string;
	expired?: boolean;
}

export interface MpMessage {
	id: string;
	author: string;
	name: string;
	color: number;
	text: string;
	at: number;
	pinned: boolean;
	pinnedBy: string | null;
	file: MpFile | null;
}

export interface MpAddress {
	address: string;
	label: "radmin" | "lan";
}

export interface MpLan {
	port: number;
	addresses: MpAddress[];
	/** The network port also speaks HTTPS, so friends can open it in a browser. */
	https?: boolean;
}

export interface MpProblem {
	code: string;
	detail?: string;
}

export interface MpAudioState {
	file: MpFile | null;
	status: "none" | "downloading" | "loaded" | "error";
	progress: number;
}

export interface MpHostAudioState {
	status: "idle" | "uploading" | "done" | "error";
	progress: number;
	name: string | null;
}

export interface MpUpload {
	id: string;
	name: string;
	progress: number;
}

export const mpPhaseAtom = atom<MpPhase>("idle");
export const mpRoleAtom = atom<MpRole | null>(null);
export const mpProblemAtom = atom<MpProblem | null>(null);
export const mpMeAtom = atom<string | null>(null);
export const mpMembersAtom = atom<MpMember[]>([]);
export const mpLanAtom = atom<MpLan | null>(null);
/** The host address a member joined, as typed ("26.1.2.3:51234"). */
export const mpAddressAtom = atom<string | null>(null);
export const mpMessagesAtom = atom<MpMessage[]>([]);
export const mpAudioAtom = atom<MpAudioState>({
	file: null,
	status: "none",
	progress: 0,
});
export const mpHostAudioAtom = atom<MpHostAudioState>({
	status: "idle",
	progress: 0,
	name: null,
});
export const mpUploadsAtom = atom<MpUpload[]>([]);
export const mpPingAtom = atom<number | null>(null);

export const mpDialogOpenAtom = atom(false);
export const mpChatOpenAtom = atom(false);
export const mpUnreadAtom = atom(0);
/** Someone opened another file while in the party; the choice dialog is up. */
export const mpDocSwitchAtom = atom(false);
/** Missing parts of the editor this version of multiplayer relies on. */
export const mpCompatAtom = atom<string[]>([]);

/** While true, Ctrl+Z and Ctrl+Y use the party's own history. */
export const mpHistoryActiveAtom = atom(false);
export const mpCanUndoAtom = atom(false);
export const mpCanRedoAtom = atom(false);

/** How many editor slots are mounted; 0 means the chat needs its own overlay. */
export const mpSlotMountsAtom = atom(0);
/** Set once the runtime should be loaded (dialog opened, party resumed). */
export const mpRuntimeWantedAtom = atom(false);

export const mpInPartyAtom = atom((get) => {
	const phase = get(mpPhaseAtom);
	return phase === "connected" || phase === "reconnecting";
});

export const mpIsHostAtom = atom((get) => get(mpRoleAtom) === "host");
