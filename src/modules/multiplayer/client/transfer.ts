// Uploads with progress (XMLHttpRequest reports upload progress, fetch does
// not) and downloads with progress.

import { CLIENT_HEADER } from "../shared/protocol.js";

export class TransferError extends Error {
	constructor(
		public code: string,
		public status = 0,
	) {
		super(code);
	}
}

export function upload(
	url: string,
	body: Blob,
	clientId: string,
	onProgress: (fraction: number) => void,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", url);
		xhr.setRequestHeader(CLIENT_HEADER, clientId);
		if (body.type) xhr.setRequestHeader("Content-Type", body.type);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) onProgress(e.loaded / e.total);
		};
		xhr.onload = () => {
			let parsed: { ok?: boolean; code?: string } | null = null;
			try {
				parsed = JSON.parse(xhr.responseText);
			} catch {
				parsed = null;
			}
			if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
			else reject(new TransferError(parsed?.code ?? "upload-failed", xhr.status));
		};
		xhr.onerror = () => reject(new TransferError("network"));
		xhr.send(body);
	});
}

export async function download(
	url: string,
	onProgress: (fraction: number) => void,
): Promise<Blob> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new TransferError("download-failed", res.status);
	const total = Number(res.headers.get("content-length") ?? "0");
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		received += value.length;
		if (total > 0) onProgress(received / total);
	}
	return new Blob(parts as BlobPart[], {
		type: res.headers.get("content-type") ?? "",
	});
}
