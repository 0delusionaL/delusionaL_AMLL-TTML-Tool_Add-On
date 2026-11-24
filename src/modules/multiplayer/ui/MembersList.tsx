import { Badge, Button, Flex, Text } from "@radix-ui/themes";
import { PersonDelete16Regular } from "@fluentui/react-icons";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { MultiplayerSession } from "../client/session";
import { useMpT } from "../i18n/useMpT";
import { type MpMember, mpIsHostAtom, mpMeAtom, mpMembersAtom } from "../state";
import { memberColor, presenceText } from "./common";
import styles from "./members.module.css";

function KickButton({ member, session }: { member: MpMember; session: MultiplayerSession }) {
	const t = useMpT();
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const timer = window.setTimeout(() => setArmed(false), 3000);
		return () => window.clearTimeout(timer);
	}, [armed]);
	return (
		<Button
			size="1"
			variant={armed ? "solid" : "soft"}
			color="red"
			onClick={() => {
				if (!armed) {
					setArmed(true);
					return;
				}
				session.kick(member.id);
			}}
		>
			<PersonDelete16Regular aria-hidden />
			{armed ? t("kickConfirm", { name: member.name }) : t("kick")}
		</Button>
	);
}

export function MembersList({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const members = useAtomValue(mpMembersAtom);
	const me = useAtomValue(mpMeAtom);
	const isHost = useAtomValue(mpIsHostAtom);
	const sorted = [...members].sort(
		(a, b) => Number(b.host) - Number(a.host) || a.name.localeCompare(b.name),
	);
	return (
		<ul className={styles.list}>
			{sorted.map((m) => (
				<li key={m.id} className={styles.row} data-member={m.id}>
					<span
						className={styles.dot}
						style={{ background: memberColor(m.color), opacity: m.online ? 1 : 0.4 }}
						aria-hidden
					/>
					<Flex direction="column" className={styles.who}>
						<Flex align="center" gap="2">
							<Text size="2" weight="medium" className={styles.name}>
								{m.name}
							</Text>
							{m.id === me && (
								<Text size="1" color="gray">
									({t("you")})
								</Text>
							)}
							{m.host && (
								<Badge size="1" variant="soft">
									{t("host")}
								</Badge>
							)}
						</Flex>
						<Text size="1" color="gray">
							{presenceText(m, t)}
						</Text>
					</Flex>
					{isHost && !m.host && <KickButton member={m} session={session} />}
				</li>
			))}
		</ul>
	);
}
