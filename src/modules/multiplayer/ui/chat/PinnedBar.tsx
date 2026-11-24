import { IconButton } from "@radix-ui/themes";
import { Pin16Regular, PinOff16Regular } from "@fluentui/react-icons";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { MultiplayerSession } from "../../client/session";
import { useMpT } from "../../i18n/useMpT";
import { mpMessagesAtom } from "../../state";
import styles from "./chat.module.css";

function jumpTo(id: string) {
	const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
	if (!el) return;
	el.scrollIntoView({ block: "center" });
	el.dataset.flash = "true";
	window.setTimeout(() => {
		delete el.dataset.flash;
	}, 1500);
}

export function PinnedBar({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const messages = useAtomValue(mpMessagesAtom);
	const [open, setOpen] = useState(false);
	const pinned = messages.filter((m) => m.pinned);
	if (pinned.length === 0) return null;
	return (
		<div className={styles.pinned}>
			<button
				type="button"
				className={styles.pinnedToggle}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<Pin16Regular aria-hidden />
				<span>{t("pinnedCount", { count: pinned.length })}</span>
				<span className={styles.pinnedHint}>{open ? t("hidePinned") : t("showPinned")}</span>
			</button>
			{open && (
				<ul className={styles.pinnedList}>
					{pinned.map((m) => (
						<li key={m.id} className={styles.pinnedItem}>
							<button
								type="button"
								className={styles.pinnedJump}
								title={t("jumpTo")}
								onClick={() => jumpTo(m.id)}
							>
								<b>{m.name}</b>
								<span>{m.text || m.file?.name || ""}</span>
							</button>
							<IconButton
								size="1"
								variant="ghost"
								color="gray"
								aria-label={t("unpin")}
								title={t("unpin")}
								onClick={() => session.setPinned(m.id, false)}
							>
								<PinOff16Regular />
							</IconButton>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
