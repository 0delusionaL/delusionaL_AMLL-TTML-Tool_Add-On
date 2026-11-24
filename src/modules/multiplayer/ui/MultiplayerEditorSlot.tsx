import { useAtomValue, useSetAtom } from "jotai";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { mpChatOpenAtom, mpInPartyAtom, mpSlotMountsAtom } from "../state";
import { MpErrorBoundary } from "./ErrorBoundary";
import styles from "./multiplayer.module.css";

const ChatView = lazy(() => import("./chat/ChatView"));

/** Shows the party chat in place of the editor while the Chat tab is selected. */
export function MultiplayerEditorSlot({ children }: { children?: ReactNode }) {
	const inParty = useAtomValue(mpInPartyAtom);
	const chatOpen = useAtomValue(mpChatOpenAtom);
	const setMounts = useSetAtom(mpSlotMountsAtom);

	useEffect(() => {
		setMounts((n) => n + 1);
		return () => setMounts((n) => n - 1);
	}, [setMounts]);

	if (!inParty || !chatOpen) return <>{children}</>;
	return (
		<div className={styles.slot}>
			<MpErrorBoundary fallback={children}>
				<Suspense fallback={null}>
					<ChatView />
				</Suspense>
			</MpErrorBoundary>
		</div>
	);
}
