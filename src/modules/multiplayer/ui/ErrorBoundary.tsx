import { Component, type ReactNode } from "react";

interface Props {
	children?: ReactNode;
	fallback?: ReactNode;
}

/** Keeps a multiplayer failure from taking the editor down with it. */
export class MpErrorBoundary extends Component<Props, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override componentDidCatch(error: unknown) {
		console.error("[multiplayer]", error);
	}

	override render() {
		return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
	}
}
