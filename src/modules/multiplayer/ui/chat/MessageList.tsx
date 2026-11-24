import { IconButton, Text } from "@radix-ui/themes";
import {
	ArrowDownload16Regular,
	Delete16Regular,
	Document16Regular,
	Pin16Regular,
	PinOff16Regular,
} from "@fluentui/react-icons";
import { useAtomValue } from "jotai";
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { MultiplayerSession } from "../../client/session";
import { useMpT } from "../../i18n/useMpT";
import { classifyLink, findLinks } from "../../shared/media-links.js";
import { type MpFile, type MpMessage, mpIsHostAtom, mpMeAtom, mpMessagesAtom } from "../../state";
import { formatBytes, formatTime, memberColor, useLanguage } from "../common";
import styles from "./chat.module.css";

const GROUP_GAP_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 2;

function MessageText({ text }: { text: string }) {
	const parts: ReactNode[] = [];
	let last = 0;
	for (const link of findLinks(text)) {
		if (link.start > last) parts.push(text.slice(last, link.start));
		parts.push(
			<a key={link.start} href={link.url} target="_blank" rel="noopener noreferrer">
				{link.url}
			</a>,
		);
		last = link.end;
	}
	if (last < text.length) parts.push(text.slice(last));
	return <div className={styles.text}>{parts}</div>;
}

function LinkPreview({ url, session }: { url: string; session: MultiplayerSession }) {
	const kind = classifyLink(url);
	const [failed, setFailed] = useState(false);
	if (!kind) return null;
	const src = kind.proxy ? session.mediaUrl(url) : url;
	return (
		<a href={url} target="_blank" rel="noopener noreferrer" hidden={failed}>
			<img
				className={styles.preview}
				src={src}
				alt=""
				loading="lazy"
				referrerPolicy="no-referrer"
				crossOrigin={kind.proxy ? undefined : "anonymous"}
				onError={() => setFailed(true)}
			/>
		</a>
	);
}

function FileBlock({ file, session }: { file: MpFile; session: MultiplayerSession }) {
	const t = useMpT();
	if (file.expired) {
		return (
			<Text size="1" color="gray">
				{t("fileExpired")}
			</Text>
		);
	}
	const url = session.fileUrl(file);
	if (file.kind === "image") {
		return (
			<a href={url} target="_blank" rel="noopener noreferrer" title={t("openImage")}>
				<img className={styles.image} src={url} alt={file.name} loading="lazy" />
			</a>
		);
	}
	return (
		<div className={styles.fileBlock}>
			{file.kind === "audio" && <audio className={styles.media} controls preload="none" src={url} />}
			{file.kind === "video" && <video className={styles.media} controls preload="metadata" src={url} />}
			<a className={styles.fileCard} href={url} download={file.name}>
				<Document16Regular aria-hidden />
				<span className={styles.fileName}>{file.name}</span>
				<span className={styles.fileSize}>{formatBytes(file.size, t)}</span>
				<ArrowDownload16Regular aria-label={t("download")} />
			</a>
		</div>
	);
}

function Message({
	message,
	showHeader,
	session,
	canDelete,
}: {
	message: MpMessage;
	showHeader: boolean;
	session: MultiplayerSession;
	canDelete: boolean;
}) {
	const t = useMpT();
	const language = useLanguage();
	const previews = findLinks(message.text)
		.map((l) => l.url)
		.filter((url) => classifyLink(url))
		.slice(0, MAX_PREVIEWS);
	return (
		<div className={styles.message} data-message-id={message.id} data-pinned={message.pinned || undefined}>
			{showHeader && (
				<div className={styles.header}>
					<span className={styles.dot} style={{ background: memberColor(message.color) }} aria-hidden />
					<span className={styles.author}>{message.name}</span>
					<span className={styles.time}>{formatTime(message.at, language)}</span>
				</div>
			)}
			{message.pinned && (
				<div className={styles.pinMark} title={message.pinnedBy ? t("pinnedBy", { name: message.pinnedBy }) : undefined}>
					<Pin16Regular aria-hidden />
					{message.pinnedBy ? t("pinnedBy", { name: message.pinnedBy }) : t("pin")}
				</div>
			)}
			{message.text && <MessageText text={message.text} />}
			{previews.map((url) => (
				<LinkPreview key={url} url={url} session={session} />
			))}
			{message.file && <FileBlock file={message.file} session={session} />}
			<div className={styles.actions}>
				<IconButton
					size="1"
					variant="soft"
					color="gray"
					aria-label={message.pinned ? t("unpin") : t("pin")}
					title={message.pinned ? t("unpin") : t("pin")}
					onClick={() => session.setPinned(message.id, !message.pinned)}
				>
					{message.pinned ? <PinOff16Regular /> : <Pin16Regular />}
				</IconButton>
				{canDelete && (
					<IconButton
						size="1"
						variant="soft"
						color="red"
						aria-label={t("delete")}
						title={t("delete")}
						onClick={() => session.deleteMessage(message.id)}
					>
						<Delete16Regular />
					</IconButton>
				)}
			</div>
		</div>
	);
}

export function MessageList({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const messages = useAtomValue(mpMessagesAtom);
	const me = useAtomValue(mpMeAtom);
	const isHost = useAtomValue(mpIsHostAtom);
	const scroller = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);
	const lastCount = useRef(0);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const last = messages.at(-1);
		const grew = messages.length > lastCount.current;
		lastCount.current = messages.length;
		if (grew && (nearBottom.current || last?.author === me)) el.scrollTop = el.scrollHeight;
	}, [messages, me]);

	return (
		<div
			ref={scroller}
			className={styles.list}
			role="log"
			aria-live="polite"
			onScroll={(e) => {
				const el = e.currentTarget;
				nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			}}
		>
			{messages.length === 0 && (
				<Text size="2" color="gray" className={styles.empty}>
					{t("emptyChat")}
				</Text>
			)}
			{messages.map((m, i) => {
				const prev = messages[i - 1];
				const showHeader = !prev || prev.author !== m.author || m.at - prev.at > GROUP_GAP_MS;
				return (
					<Fragment key={m.id}>
						<Message
							message={m}
							showHeader={showHeader}
							session={session}
							canDelete={isHost || m.author === me}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}
