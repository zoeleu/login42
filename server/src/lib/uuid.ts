// Canonical Minecraft UUID for a 42 user: an RFC 9562 version-8 UUID that embeds the
// immutable 42 numeric id directly (no hashing), so the mapping is injective and reversible.
// High 64 bits: fixed non-zero tag (version nibble 8). Low 64 bits: variant bits `10` then ft_id.
// Version 8 can never equal a Mojang (v4) or vanilla offline (v3) UUID; the non-zero high half
// keeps it distinct from Floodgate's `new UUID(0, xuid)`.

const TAG_HI = 0x34324c4f47498a2bn;
const VARIANT = 0x8000000000000000n;
const MAX_FT_ID = 1n << 56n;

export function ftIdToUuid(ftId: number): string {
	const id = BigInt(ftId);
	if (!Number.isSafeInteger(ftId) || id <= 0n || id >= MAX_FT_ID) {
		throw new RangeError(`invalid 42 id: ${ftId}`);
	}
	const hex = TAG_HI.toString(16).padStart(16, "0") + (VARIANT | id).toString(16).padStart(16, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidToFtId(uuid: string): number | null {
	const hex = uuid.replaceAll("-", "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(hex)) return null;
	if (BigInt(`0x${hex.slice(0, 16)}`) !== TAG_HI) return null;
	const lo = BigInt(`0x${hex.slice(16)}`);
	if ((lo & ~(MAX_FT_ID - 1n)) !== VARIANT) return null;
	return Number(lo & (MAX_FT_ID - 1n));
}
