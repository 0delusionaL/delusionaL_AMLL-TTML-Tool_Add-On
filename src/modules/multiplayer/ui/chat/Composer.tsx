import { Button, IconButton, TextArea } from "@radix-ui/themes";
import { Attach20Regular, Send20Filled } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { MultiplayerSession } from "../../client/session";
import { useMpT } from "../../i18n/useMpT";
import { LIMITS } from "../../shared/protocol.js";
import styles from "./chat.module.css";

export function Composer({
	session,
	onFiles,
}: {
	session: MultiplayerSession;
	onFiles: (files: File[]) => void;
}) {
	const t = useMpT();
	const [text, setText] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
	}, []);

	const send = () => {
		if (!text.trim()) return;
		session.sendChat(text);
		setText("");
	};

	return (
		<div className={styles.composer}>
			<IconButton
				variant="ghost"
				color="gray"
				aria-label={t("attach")}
				title={t("attach")}
				onClick={() => picker.current?.click()}
			>
				<Attach20Regular />
			</IconButton>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []);
					e.currentTarget.value = "";
					if (files.length > 0) onFiles(files);
				}}
			/>
			<TextArea
				ref={input}
				className={styles.input}
				value={text}
				rows={1}
				maxLength={LIMITS.messageChars}
				placeholder={t("messagePlaceholder")}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						send();
					}
				}}
				onPaste={(e) => {
					const files = Array.from(e.clipboardData.files);
					if (files.length > 0) {
						e.preventDefault();
						onFiles(files);
					}
				}}
			/>
			<Button onClick={send} disabled={!text.trim()}>
				<Send20Filled aria-hidden />
				{t("send")}
			</Button>
		</div>
	);
}
