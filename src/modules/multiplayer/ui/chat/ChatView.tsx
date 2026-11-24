import { Text } from "@radix-ui/themes";
import { useAtomValue, useStore } from "jotai";
import { type DragEvent, useCallback, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { getSession } from "../../client/session";
import { TransferError } from "../../client/transfer";
import { useMpT } from "../../i18n/useMpT";
import { LIMITS } from "../../shared/protocol.js";
import { mpUploadsAtom } from "../../state";
import { stopEditorKeys } from "../common";
import { MembersList } from "../MembersList";
import styles from "./chat.module.css";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { PinnedBar } from "./PinnedBar";

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

export default function ChatView() {
	const store = useStore();
	const session = useMemo(() => getSession(store), [store]);
	const t = useMpT();
	const uploads = useAtomValue(mpUploadsAtom);
	const [dragging, setDragging] = useState(false);

	const onFiles = useCallback(
		(files: File[]) => {
			for (const file of files) {
				if (file.size > LIMITS.chatFileBytes) {
					toast.error(t("noticeTooLarge"));
					continue;
				}
				session.uploadChatFile(file).catch((error: unknown) => {
					const code = error instanceof TransferError ? error.code : "";
					toast.error(t(code === "too-large" ? "noticeTooLarge" : "noticeUploadFailed"));
				});
			}
		},
		[session, t],
	);

	// The editor opens files dropped anywhere on the window; in the chat a drop
	// means "send this", so the event stops here.
	const onDrag = (e: DragEvent, entering: boolean) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		e.stopPropagation();
		setDragging(entering);
	};

	return (
		<div
			className={styles.chat}
			onKeyDown={stopEditorKeys}
			onKeyUp={stopEditorKeys}
			onDragEnter={(e) => onDrag(e, true)}
			onDragOver={(e) => onDrag(e, true)}
			onDragLeave={(e) => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				onDrag(e, false);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				e.stopPropagation();
				setDragging(false);
				onFiles(Array.from(e.dataTransfer.files));
			}}
		>
			<section className={styles.main} aria-label={t("chatTitle")}>
				<PinnedBar session={session} />
				<MessageList session={session} />
				{uploads.length > 0 && (
					<div className={styles.uploads}>
						{uploads.map((u) => (
							<Text key={u.id} size="1" color="gray">
								{t("uploading", { name: u.name, percent: Math.round(u.progress * 100) })}
							</Text>
						))}
					</div>
				)}
				<Composer session={session} onFiles={onFiles} />
			</section>
			<aside className={styles.side} aria-label={t("players")}>
				<Text size="2" weight="medium" className={styles.sideTitle}>
					{t("players")}
				</Text>
				<MembersList session={session} />
			</aside>
			{dragging && (
				<div className={styles.drop} aria-hidden>
					{t("dropHere")}
				</div>
			)}
		</div>
	);
}
