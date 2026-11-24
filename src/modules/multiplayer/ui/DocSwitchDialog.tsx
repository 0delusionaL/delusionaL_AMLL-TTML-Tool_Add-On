import { Button, Dialog, Flex } from "@radix-ui/themes";
import { useAtomValue } from "jotai";
import type { MultiplayerSession } from "../client/session";
import { useMpT } from "../i18n/useMpT";
import { mpDocSwitchAtom } from "../state";
import { stopEditorKeys } from "./common";

/** Asks what to do when someone opens or creates another file during a party. */
export default function DocSwitchDialog({ session }: { session: MultiplayerSession }) {
	const t = useMpT();
	const open = useAtomValue(mpDocSwitchAtom);
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				// Dismissing keeps everyone's lyrics as they are.
				if (!next) session.resolveDocSwitch("restore");
			}}
		>
			<Dialog.Content maxWidth="460px" onKeyDown={stopEditorKeys}>
				<Dialog.Title>{t("switchTitle")}</Dialog.Title>
				<Dialog.Description size="2">{t("switchDesc")}</Dialog.Description>
				<Flex direction="column" gap="2" mt="4">
					<Button onClick={() => session.resolveDocSwitch("replace")}>{t("switchReplace")}</Button>
					<Button variant="soft" onClick={() => session.resolveDocSwitch("restore")}>
						{t("switchRestore")}
					</Button>
					<Button variant="soft" color="red" onClick={() => session.resolveDocSwitch("leave")}>
						{t("switchLeave")}
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
}
