import { SegmentedControl } from "@radix-ui/themes";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type ComponentProps, lazy, Suspense, useEffect, useRef } from "react";
import { resumeInfo } from "../client/storage";
import { useMpT } from "../i18n/useMpT";
import {
	mpChatOpenAtom,
	mpInPartyAtom,
	mpRuntimeWantedAtom,
	mpUnreadAtom,
} from "../state";
import { MpErrorBoundary } from "./ErrorBoundary";
import styles from "./multiplayer.module.css";

const GlobalHost = lazy(() => import("./GlobalHost"));

export const CHAT_TAB = "multiplayer-chat";

type RootProps = ComponentProps<typeof SegmentedControl.Root>;

/**
 * The editor's mode switch (Edit / Time / Preview) with a Chat tab added at
 * the end while you are in a party. Takes the same props as
 * SegmentedControl.Root.
 */
export function MultiplayerModeSwitch({ value, onValueChange, children, ...rest }: RootProps) {
	const t = useMpT();
	const inParty = useAtomValue(mpInPartyAtom);
	const [chatOpen, setChatOpen] = useAtom(mpChatOpenAtom);
	const unread = useAtomValue(mpUnreadAtom);
	const [wanted, setWanted] = useAtom(mpRuntimeWantedAtom);
	const setUnread = useSetAtom(mpUnreadAtom);
	const showChat = inParty && chatOpen;

	// A tab reloaded during a party rejoins on its own.
	useEffect(() => {
		if (resumeInfo()) setWanted(true);
	}, [setWanted]);

	// Switching modes by shortcut leaves the chat.
	const previous = useRef(value);
	useEffect(() => {
		if (previous.current === value) return;
		previous.current = value;
		setChatOpen(false);
	}, [value, setChatOpen]);

	useEffect(() => {
		if (showChat) setUnread(0);
	}, [showChat, setUnread]);

	return (
		<>
			<SegmentedControl.Root
				{...rest}
				value={showChat ? CHAT_TAB : value}
				onValueChange={(next) => {
					if (next === CHAT_TAB) {
						setChatOpen(true);
						return;
					}
					setChatOpen(false);
					onValueChange?.(next);
				}}
			>
				{children}
				{inParty && (
					<SegmentedControl.Item value={CHAT_TAB}>
						<span className={styles.chatTab} title={t("chatTabDesc")}>
							{t("chatTab")}
							{unread > 0 && !showChat && (
								<span className={styles.unread} aria-label={t("unread", { count: unread })}>
									{unread > 99 ? "99+" : unread}
								</span>
							)}
						</span>
					</SegmentedControl.Item>
				)}
			</SegmentedControl.Root>
			{(wanted || inParty) && (
				<MpErrorBoundary>
					<Suspense fallback={null}>
						<GlobalHost />
					</Suspense>
				</MpErrorBoundary>
			)}
		</>
	);
}
