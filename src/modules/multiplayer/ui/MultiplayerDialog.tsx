import {
	Button,
	Callout,
	Card,
	Code,
	Dialog,
	Flex,
	Heading,
	IconButton,
	Spinner,
	Text,
	TextField,
} from "@radix-ui/themes";
import {
	ArrowDownload16Regular,
	Chat16Regular,
	CheckmarkCircle16Regular,
	Copy16Regular,
	ErrorCircle16Regular,
	Globe16Regular,
	MusicNote216Regular,
	PlugDisconnected16Regular,
	Warning16Regular,
} from "@fluentui/react-icons";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useId, useState } from "react";
import { findLocalServer, servedFromHost } from "../client/local-server";
import type { MultiplayerSession } from "../client/session";
import { savedAddress, savedName, savedPort } from "../client/storage";
import { getUpstream } from "../client/upstream";
import type { MpKey } from "../i18n/strings";
import { type MpT, useMpT } from "../i18n/useMpT";
import {
	type MpProblem,
	mpAddressAtom,
	mpAudioAtom,
	mpChatOpenAtom,
	mpCompatAtom,
	mpDialogOpenAtom,
	mpHostAudioAtom,
	mpLanAtom,
	mpMembersAtom,
	mpPhaseAtom,
	mpProblemAtom,
	mpRoleAtom,
} from "../state";
import { copyText, stopEditorKeys } from "./common";
import styles from "./dialog.module.css";
import { MembersList } from "./MembersList";

const falseAtom = atom(false);
const nullAtom = atom(null);

const PROBLEM_KEYS: Record<string, MpKey> = {
	unreachable: "problemUnreachable",
	"bad-address": "problemBadAddress",
	"no-local-server": "noLocalServer",
	"port-busy": "problemPortBusy",
	"already-hosting": "problemAlreadyHosting",
	"no-session": "problemNoSession",
	version: "problemVersion",
	full: "problemFull",
	kicked: "problemKicked",
	"host-closed": "problemHostClosed",
	lost: "problemLost",
	replaced: "problemReplaced",
	"not-allowed": "problemNotAllowed",
};

export function problemText(problem: MpProblem, t: MpT) {
	if (problem.code === "incompatible") return t("incompatible", { parts: problem.detail ?? "" });
	const key = PROBLEM_KEYS[problem.code];
	return key ? t(key) : t("problemGeneric", { code: problem.code });
}

function ProblemCallout({ problem }: { problem: MpProblem }) {
	const t = useMpT();
	const soft = problem.code === "host-closed";
	return (
		<Callout.Root color={soft ? "gray" : "red"} size="1" mt="3" role="alert">
			<Callout.Icon>{soft ? <PlugDisconnected16Regular /> : <ErrorCircle16Regular />}</Callout.Icon>
			<Callout.Text>{problemText(problem, t)}</Callout.Text>
		</Callout.Root>
	);
}

function Field({
	label,
	value,
	onChange,
	placeholder,
	inputMode,
	onEnter,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	inputMode?: "numeric" | "text";
	onEnter?: () => void;
}) {
	const id = useId();
	return (
		<Flex direction="column" gap="1" className={styles.field}>
			<Text as="label" htmlFor={id} size="2" weight="medium">
				{label}
			</Text>
			<TextField.Root
				id={id}
				value={value}
				placeholder={placeholder}
				inputMode={inputMode}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && onEnter) onEnter();
				}}
			/>
		</Flex>
	);
}

function ConnectPanel({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const phase = useAtomValue(mpPhaseAtom);
	const role = useAtomValue(mpRoleAtom);
	const isDirty = useAtomValue(getUpstream().isDirtyAtom ?? falseAtom);
	const [name, setName] = useState(savedName);
	const [port, setPort] = useState(savedPort);
	const [address, setAddress] = useState(savedAddress);
	const [canHost, setCanHost] = useState<boolean | null>(null);
	const [confirmJoin, setConfirmJoin] = useState(false);
	const connecting = phase === "connecting";

	useEffect(() => {
		let alive = true;
		void findLocalServer().then((found) => alive && setCanHost(found !== null));
		void servedFromHost().then((host) => {
			if (alive && host) setAddress(host);
		});
		return () => {
			alive = false;
		};
	}, []);

	const host = () => void session.openNetwork({ name, port: Number(port) || 0 });
	const join = () => {
		if (isDirty && !confirmJoin) {
			setConfirmJoin(true);
			return;
		}
		setConfirmJoin(false);
		void session.join({ address, name });
	};

	return (
		<Flex direction="column" gap="3" mt="4">
			<Field
				label={t("nickname")}
				value={name}
				onChange={setName}
				placeholder={t("nicknamePlaceholder")}
			/>
			<Card size="2">
				<Flex direction="column" gap="2">
					<Heading as="h3" size="3">
						<Flex align="center" gap="2">
							<Globe16Regular aria-hidden />
							{t("hostTitle")}
						</Flex>
					</Heading>
					<Text size="2" color="gray">
						{t("hostDesc")}
					</Text>
					{canHost === false ? (
						<Callout.Root color="gray" size="1">
							<Callout.Icon>
								<Warning16Regular />
							</Callout.Icon>
							<Callout.Text>{t("noLocalServer")}</Callout.Text>
						</Callout.Root>
					) : (
						<Flex align="end" gap="2">
							<Field
								label={t("portLabel")}
								value={port}
								onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))}
								placeholder={t("portPlaceholder")}
								inputMode="numeric"
								onEnter={host}
							/>
							<Button onClick={host} disabled={connecting || canHost === null}>
								{connecting && role === "host" && <Spinner size="1" />}
								{t("openNetwork")}
							</Button>
						</Flex>
					)}
				</Flex>
			</Card>
			<Card size="2">
				<Flex direction="column" gap="2">
					<Heading as="h3" size="3">
						{t("joinTitle")}
					</Heading>
					<Text size="2" color="gray">
						{t("joinDesc")}
					</Text>
					<Flex align="end" gap="2">
						<Field
							label={t("addressLabel")}
							value={address}
							onChange={(v) => {
								setAddress(v);
								setConfirmJoin(false);
							}}
							placeholder="26.12.34.56:51234"
							onEnter={join}
						/>
						<Button onClick={join} disabled={connecting || !address.trim()}>
							{connecting && role === "member" && <Spinner size="1" />}
							{t("join")}
						</Button>
					</Flex>
					{confirmJoin && (
						<Callout.Root color="amber" size="1">
							<Callout.Icon>
								<Warning16Regular />
							</Callout.Icon>
							<Callout.Text>{t("joinReplaces")}</Callout.Text>
						</Callout.Root>
					)}
				</Flex>
			</Card>
		</Flex>
	);
}

function AddressRow({ text, label }: { text: string; label: string }) {
	const t = useMpT();
	const [copied, setCopied] = useState(false);
	return (
		<Flex align="center" gap="2" className={styles.address}>
			<Text size="1" color="gray" className={styles.addressLabel}>
				{label}
			</Text>
			<Code size="3" variant="ghost">
				{text}
			</Code>
			<IconButton
				size="1"
				variant="ghost"
				aria-label={copied ? t("copied") : t("copy")}
				title={copied ? t("copied") : t("copy")}
				onClick={() => {
					void copyText(text).then((ok) => {
						setCopied(ok);
						if (ok) window.setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <CheckmarkCircle16Regular /> : <Copy16Regular />}
			</IconButton>
		</Flex>
	);
}

function HostAudio({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const loaded = useAtomValue(getUpstream().loadedAudioAtom ?? nullAtom) as Blob | null;
	const state = useAtomValue(mpHostAudioAtom);
	const hasAudio = loaded instanceof Blob && loaded.size > 0;
	const loadedName = hasAudio ? (loaded as File).name || null : null;
	const isNew = state.status === "done" && loadedName !== null && loadedName !== state.name;
	return (
		<Flex direction="column" gap="2">
			{state.status === "uploading" && (
				<Text size="2">
					{t("audioUploading", { name: state.name ?? "", percent: Math.round(state.progress * 100) })}
				</Text>
			)}
			{state.status === "done" && !isNew && (
				<Text size="2" color="green">
					{t("audioShared", { name: state.name ?? "" })}
				</Text>
			)}
			{!hasAudio && (
				<Text size="2" color="gray">
					{t("noAudioLoaded")}
				</Text>
			)}
			<Flex>
				<Button
					variant="soft"
					disabled={!hasAudio || state.status === "uploading"}
					onClick={() => void session.shareAudio()}
				>
					<MusicNote216Regular aria-hidden />
					{state.status === "done" ? t("shareNewAudio") : t("shareAudio")}
				</Button>
			</Flex>
		</Flex>
	);
}

function MemberAudio({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const audio = useAtomValue(mpAudioAtom);
	if (!audio.file) {
		return (
			<Text size="2" color="gray">
				{t("audioWaiting")}
			</Text>
		);
	}
	return (
		<Flex direction="column" gap="1">
			<Text size="2">{t("audioFromHost", { name: audio.file.name })}</Text>
			<Flex align="center" gap="2">
				{audio.status === "downloading" && (
					<Text size="2" color="gray">
						{t("audioDownloading", { percent: Math.round(audio.progress * 100) })}
					</Text>
				)}
				{audio.status === "loaded" && (
					<Text size="2" color="green">
						{t("audioLoaded")}
					</Text>
				)}
				{audio.status === "error" && (
					<Text size="2" color="red">
						{t("audioFailed")}
					</Text>
				)}
				<Button asChild size="1" variant="ghost">
					<a href={session.fileUrl(audio.file)} download={audio.file.name}>
						<ArrowDownload16Regular aria-hidden />
						{t("download")}
					</a>
				</Button>
			</Flex>
		</Flex>
	);
}

function PartyPanel({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const phase = useAtomValue(mpPhaseAtom);
	const role = useAtomValue(mpRoleAtom);
	const lan = useAtomValue(mpLanAtom);
	const address = useAtomValue(mpAddressAtom);
	const members = useAtomValue(mpMembersAtom);
	const setChatOpen = useSetAtom(mpChatOpenAtom);
	const setOpen = useSetAtom(mpDialogOpenAtom);
	const hostName = members.find((m) => m.host)?.name ?? "";
	const radmin = lan?.addresses.filter((a) => a.label === "radmin") ?? [];
	const others = lan?.addresses.filter((a) => a.label !== "radmin") ?? [];
	// The same address works in a browser and in a friend's own copy.
	const shown = (address: string) => `${lan?.https ? "https://" : ""}${address}:${lan?.port}`;

	return (
		<Flex direction="column" gap="3" mt="4">
			{phase === "reconnecting" && (
				<Callout.Root color="amber" size="1">
					<Callout.Icon>
						<Spinner size="1" />
					</Callout.Icon>
					<Callout.Text>{t("reconnecting")}</Callout.Text>
				</Callout.Root>
			)}
			{role === "host" && lan ? (
				<Card size="2">
					<Flex direction="column" gap="2">
						<Flex align="center" gap="2">
							<CheckmarkCircle16Regular aria-hidden className={styles.ok} />
							<Text size="2" weight="medium">
								{t("networkOpen", { port: lan.port })}
							</Text>
						</Flex>
						<Text size="1" color="gray">
							{t("addressesTitle")}
						</Text>
						{radmin.map((a) => (
							<AddressRow key={a.address} text={shown(a.address)} label={t("radmin")} />
						))}
						{others.map((a) => (
							<AddressRow key={a.address} text={shown(a.address)} label={t("lan")} />
						))}
						{radmin.length === 0 && (
							<Text size="1" color="amber">
								{t("noRadmin")}
							</Text>
						)}
						{lan.https && (
							<Text size="1" color="gray">
								{t("browserHint")}
							</Text>
						)}
						<Text size="1" color="gray">
							{t("firewallHint")}
						</Text>
					</Flex>
				</Card>
			) : (
				<Card size="2">
					<Flex direction="column" gap="1">
						<Text size="2" weight="medium">
							{t("inPartyOf", { name: hostName })}
						</Text>
						{address && (
							<Code size="2" variant="ghost">
								{address}
							</Code>
						)}
					</Flex>
				</Card>
			)}
			<Card size="2">
				<Flex direction="column" gap="2">
					<Heading as="h3" size="2">
						{t("audioTitle")}
					</Heading>
					{role === "host" ? <HostAudio session={session} /> : <MemberAudio session={session} />}
				</Flex>
			</Card>
			<Card size="2">
				<Flex direction="column" gap="2">
					<Heading as="h3" size="2">
						{t("playersTitle", { count: members.length })}
					</Heading>
					<MembersList session={session} />
				</Flex>
			</Card>
			<Flex gap="2" justify="between">
				<Button
					onClick={() => {
						setChatOpen(true);
						setOpen(false);
					}}
				>
					<Chat16Regular aria-hidden />
					{t("openChat")}
				</Button>
				<Button variant="soft" color="red" onClick={() => session.leave()}>
					{role === "host" ? t("closeNetwork") : t("leave")}
				</Button>
			</Flex>
		</Flex>
	);
}

export default function MultiplayerDialog({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const [open, setOpen] = useAtom(mpDialogOpenAtom);
	const phase = useAtomValue(mpPhaseAtom);
	const problem = useAtomValue(mpProblemAtom);
	const compat = useAtomValue(mpCompatAtom);
	const inParty = phase === "connected" || phase === "reconnecting";
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Content maxWidth="560px" onKeyDown={stopEditorKeys}>
				<Dialog.Title>{t("title")}</Dialog.Title>
				<Dialog.Description size="2" color="gray">
					{t("description")}
				</Dialog.Description>
				{problem && <ProblemCallout problem={problem} />}
				{!problem && compat.length > 0 && !inParty && (
					<Text as="p" size="1" color="gray" mt="2">
						{t("incompatible", { parts: compat.join(", ") })}
					</Text>
				)}
				{inParty ? <PartyPanel session={session} /> : <ConnectPanel session={session} />}
				<Flex justify="end" mt="4">
					<Dialog.Close>
						<Button variant="soft" color="gray">
							{t("close")}
						</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
}
