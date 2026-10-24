import { describe, expect, it } from "bun:test";
import { hmacHex, hmacVerify, signingString } from "../src/lib/hmac";
import { authorizeUrl, isEligible, selectedTitle, type FtMe } from "../src/lib/ft42";
import { mcNameFromLogin } from "../src/lib/util";
import { ftIdToUuid, uuidToFtId } from "../src/lib/uuid";

const me = (o: Partial<FtMe>): FtMe => ({
	id: 1, login: "a", kind: "student", "staff?": false, "alumni?": false, "active?": true, ...o,
});

describe("42 authorization URL", () => {
	it("preserves the required parameters and encodes callback and state exactly once", () => {
		const callback = "https://example.test/auth/callback";
		const state = "test-state_123&other=value";
		const u = new URL(authorizeUrl("test-client", callback, state));
		expect(u.origin + u.pathname).toBe("https://api.intra.42.fr/oauth/authorize");
		expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "test-client", redirect_uri: callback, response_type: "code", scope: "public", state });
	});
});

describe("selected Intra title", () => {
	it("uses only the selected title, substituting the 42 login", () => {
		expect(selectedTitle(me({ login: "jdoe", titles: [{ id: 55, name: "Mastermind %login" }, { id: 1328, name: "%login, Writer's soul" }], titles_users: [{ title_id: 55, selected: false }, { title_id: 1328, selected: true }] }))).toBe("jdoe, Writer's soul");
	});
	it("removes a title when none is selected or the selected title is missing", () => {
		expect(selectedTitle(me({}))).toBeNull();
		expect(selectedTitle(me({ titles: [{ id: 1, name: "Earned title" }], titles_users: [{ title_id: 1, selected: false }] }))).toBeNull();
		expect(selectedTitle(me({ titles_users: [{ title_id: 1, selected: true }] }))).toBeNull();
	});
	it("limits title length and removes legacy formatting and control characters", () => {
		expect(selectedTitle(me({ titles: [{ id: 1, name: "\nHello\u00a7\u0000" }], titles_users: [{ title_id: 1, selected: true }] }))).toBe("Hello");
		expect(selectedTitle(me({ titles: [{ id: 1, name: "x".repeat(300) }], titles_users: [{ title_id: 1, selected: true }] }))?.length).toBe(256);
	});
});

describe("uuid", () => {
	it("roundtrips and is v8 / RFC variant", () => {
		for (const id of [1, 2, 56911, 2 ** 31, 2 ** 52]) {
			const u = ftIdToUuid(id);
			expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidToFtId(u)).toBe(id);
		}
	});
	it("is injective on a range and never has msb == 0", () => {
		const seen = new Set<string>();
		for (let i = 1; i <= 20000; i++) seen.add(ftIdToUuid(i));
		expect(seen.size).toBe(20000);
		expect(ftIdToUuid(1).startsWith("00000000")).toBe(false);
	});
	it("rejects foreign uuids and bad ids", () => {
		expect(uuidToFtId("069a79f4-44e9-4726-a5be-fca90e38aaf5")).toBeNull();
		expect(() => ftIdToUuid(0)).toThrow();
		expect(() => ftIdToUuid(-5)).toThrow();
		expect(() => ftIdToUuid(1.5)).toThrow();
	});
});

describe("eligibility", () => {
	it("admits active students only", () => {
		expect(isEligible(me({}), false)).toBe(true);
		expect(isEligible(me({ "active?": false }), false)).toBe(false);
		expect(isEligible(me({ "alumni?": true }), false)).toBe(false);
		expect(isEligible(me({ kind: "external" }), false)).toBe(false);
	});
	it("staff only when allowed", () => {
		expect(isEligible(me({ "staff?": true, kind: "admin" }), false)).toBe(false);
		expect(isEligible(me({ "staff?": true, kind: "admin" }), true)).toBe(true);
	});
});

describe("hmac", () => {
	it("verifies and rejects tampering", async () => {
		const msg = signingString("1700000000000", "post", "/api/v1/join-check", '{"a":1}');
		const sig = await hmacHex("s3cret", msg);
		expect(await hmacVerify("s3cret", msg, sig)).toBe(true);
		expect(await hmacVerify("other", msg, sig)).toBe(false);
		expect(await hmacVerify("s3cret", msg + "x", sig)).toBe(false);
		expect(await hmacVerify("s3cret", msg, "zz")).toBe(false);
	});
});

describe("mcNameFromLogin", () => {
	it("maps hyphens to underscores", () => {
		expect(mcNameFromLogin("jdoe")).toBe("jdoe");
		expect(mcNameFromLogin("jean-luc")).toBe("jean_luc");
	});
	it("rejects what Minecraft cannot use instead of guessing", () => {
		expect(mcNameFromLogin("")).toBeNull();
		expect(mcNameFromLogin("a".repeat(17))).toBeNull();
		expect(mcNameFromLogin("bad name")).toBeNull();
		expect(mcNameFromLogin("héllo")).toBeNull();
	});
});

import { checkSkinPng } from "../src/lib/mineskin";

function png(w: number, h: number, extra = 0): Uint8Array {
	const b = new Uint8Array(33 + extra);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const dv = new DataView(b.buffer);
	dv.setUint32(8, 13);
	dv.setUint32(12, 0x49484452);
	dv.setUint32(16, w);
	dv.setUint32(20, h);
	return b;
}

describe("checkSkinPng", () => {
	it("accepts 64x64 and legacy 64x32", () => {
		expect(checkSkinPng(png(64, 64))).toBeNull();
		expect(checkSkinPng(png(64, 32))).toBeNull();
	});
	it("rejects other sizes, non-PNG and oversize files", () => {
		expect(checkSkinPng(png(128, 128))).toMatch(/64x64/);
		expect(checkSkinPng(new Uint8Array(100))).toMatch(/not a PNG/);
		expect(checkSkinPng(png(64, 64, 70_000))).toMatch(/under 64 KB/);
		expect(checkSkinPng(new Uint8Array(3))).toMatch(/under 64 KB/);
	});
});
