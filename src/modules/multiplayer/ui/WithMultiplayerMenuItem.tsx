import { DropdownMenu } from "@radix-ui/themes";
import { useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useMpT } from "../i18n/useMpT";
import { mpDialogOpenAtom, mpRuntimeWantedAtom } from "../state";

/**
 * Renders the Edit menu's own items, then "Multiplayer...". The item comes
 * after everything the editor puts in the menu, so it stays last whatever
 * gets added there.
 */
export function WithMultiplayerMenuItem({ children }: { children?: ReactNode }) {
	const t = useMpT();
	const setOpen = useSetAtom(mpDialogOpenAtom);
	const setWanted = useSetAtom(mpRuntimeWantedAtom);
	return (
		<>
			{children}
			<DropdownMenu.Separator />
			<DropdownMenu.Item
				onSelect={() => {
					setWanted(true);
					setOpen(true);
				}}
			>
				{t("menuItem")}
			</DropdownMenu.Item>
		</>
	);
}
