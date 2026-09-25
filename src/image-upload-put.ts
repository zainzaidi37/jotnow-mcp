// Shared by the Node client and the opt-in R2 wire check. Keep this module
// dependency-free so the live check can import it directly from src.
export interface PutGrant {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

function isDuplicateReply(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      'statusCode' in parsed &&
      parsed.statusCode === '409' &&
      'error' in parsed &&
      parsed.error === 'Duplicate' &&
      'message' in parsed &&
      parsed.message === 'The resource already exists' &&
      'code' in parsed &&
      parsed.code === 'KeyAlreadyExists'
    );
  } catch {
    return false;
  }
}

async function duplicateBody(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    // A byte budget plus a read budget also bounds streams that yield empty chunks.
    for (let reads = 0; reads < 4096 && length < 4096; reads++) {
      const { done, value } = await reader.read();
      if (done) {
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(body);
      }
      if (length + value.length > 4096) return '';
      chunks.push(value);
      length += value.length;
    }
    return '';
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// The signed URL is a credential. A failure may name only its host.
export async function performImagePut(
  grant: PutGrant,
  bytes: Uint8Array,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const host = new URL(grant.uploadUrl).host;
  const deadline = Date.now() + grant.expiresInSeconds * 1_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (Date.now() >= deadline) throw new Error(`Image upload grant for ${host} expired.`);
    let response: Response;
    try {
      response = await fetchImpl(grant.uploadUrl, {
        method: grant.method,
        headers: grant.headers,
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      if (attempt === 0) continue;
      throw new Error(`Image upload to ${host} failed after two attempts.`);
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (attempt === 1 && response.status === 400) {
      if (isDuplicateReply(response.status, await duplicateBody(response))) return;
    } else {
      await response.body?.cancel().catch(() => {});
    }
    if (response.status >= 500 && attempt === 0) continue;
    throw new Error(`Image upload to ${host} failed (HTTP ${response.status}).`);
  }
  throw new Error(`Image upload to ${host} failed after two attempts.`);
}
