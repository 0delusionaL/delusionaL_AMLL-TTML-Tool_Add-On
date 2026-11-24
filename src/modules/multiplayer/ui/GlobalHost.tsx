// Everything multiplayer keeps mounted once it is in use: the session wiring,
// notifications, the dialogs, and a chat overlay for when the editor offers
// no slot for it.

import { useAtomValue, useStore } from "jotai";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { toast } from "react-toastify";
import { getSession, type Notice } from "../client/session";
import { getUpstream, type LoadAudioHook } from "../client/upstream";
import { type MpT, useMpT } from "../i18n/useMpT";
import { mpChatOpenAtom, mpInPartyAtom, mpSlotMountsAtom } from "../state";
import DocSwitchDialog from "./DocSwitchDialog";
import { MpErrorBoundary } from "./ErrorBoundary";
import MultiplayerDialog from "./MultiplayerDialog";
import styles from "./multiplayer.module.css";

const ChatView = lazy(() => import("./chat/ChatView"));

const noLoader: LoadAudioHook = () => ({});
const useLoadAudio: LoadAudioHook = getUpstream().useLoadAudio ?? noLoader;

const ERROR_KEYS: Record<string, Parameters<MpT>[0]> = {
	"too-long": "noticeTooLong",
	rate: "noticeRate",
	"too-large": "noticeTooLarge",
	"upload-failed": "noticeUploadFailed",
	network: "noticeUploadFailed",
	"too-many-pins": "noticeTooManyPins",
	"no-audio": "noAudioLoaded",
	"audio-too-large": "noticeAudioTooLarge",
	"not-allowed": "problemNotAllowed",
};

export function showNotice(notice: Notice, t: MpT) {
	switch (notice.kind) {
		case "joined":
			toast.info(t("noticeJoined", { name: notice.name ?? "" }));
			return;
		case "left":
			toast.info(t("noticeLeft", { name: notice.name ?? "" }));
			return;
		case "kicked-member":
			toast.info(t("noticeKicked", { name: notice.name ?? "" }));
			return;
		case "kicked":
			toast.warn(t("problemKicked"));
			return;
		case "host-closed":
			toast.info(t("problemHostClosed"));
			return;
		case "reconnecting":
			toast.warn(t("reconnecting"));
			return;
		case "reconnected":
			toast.success(t("noticeReconnected"));
			return;
		case "lost":
			toast.error(t("problemLost"));
			return;
		case "audio-loaded":
			toast.success(t("noticeAudioLoaded", { name: notice.name ?? "" }));
			return;
		case "audio-failed":
			toast.error(t("noticeAudioFailed"));
			return;
		case "doc-switch":
			return;
		case "error": {
			const key = notice.code ? ERROR_KEYS[notice.code] : undefined;
			toast.error(key ? t(key) : t("problemGeneric", { code: notice.code ?? "?" }));
			return;
		}
	}
}

/**
 * While the chat covers the editor, keys pressed with nothing focused must
 * not reach the editor's shortcuts (Delete, Space in Time mode...).
 */
function useKeyGuard(active: boolean) {
	useEffect(() => {
		if (!active) return;
		const guard = (event: KeyboardEvent) => {
			const target = event.target;
			if (target === document.body || target === document.documentElement) {
				event.stopPropagation();
			}
		};
		window.addEventListener("keydown", guard, true);
		window.addEventListener("keyup", guard, true);
		return () => {
			window.removeEventListener("keydown", guard, true);
			window.removeEventListener("keyup", guard, true);
		};
	}, [active]);
}

export default function GlobalHost() {
	const store = useStore();
	const session = useMemo(() => getSession(store), [store]);
	const t = useMpT();
	const inParty = useAtomValue(mpInPartyAtom);
	const chatOpen = useAtomValue(mpChatOpenAtom);
	const slots = useAtomValue(mpSlotMountsAtom);
	const { openAudioFile } = useLoadAudio();

	useEffect(() => {
		session.setAudioLoader(openAudioFile ? (file) => openAudioFile(file) : null);
		return () => session.setAudioLoader(null);
	}, [session, openAudioFile]);

	useEffect(() => {
		void session.resumeIfNeeded();
	}, [session]);

	useEffect(() => session.on((notice) => showNotice(notice, t)), [session, t]);

	useKeyGuard(inParty && chatOpen);

	return (
		<>
			<MultiplayerDialog session={session} />
			<DocSwitchDialog session={session} />
			{inParty && chatOpen && slots === 0 && (
				<div className={styles.overlay}>
					<MpErrorBoundary>
						<Suspense fallback={null}>
							<ChatView />
						</Suspense>
					</MpErrorBoundary>
				</div>
			)}
		</>
	);
}
