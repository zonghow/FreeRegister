import assert from "node:assert/strict";
import test from "node:test";
import {formatUtc8Timestamp} from "../src/utils.js";

test("formats timestamps in fixed UTC+8 timezone", () => {
    assert.equal(
        formatUtc8Timestamp(new Date(Date.UTC(2026, 5, 22, 8, 39, 42))),
        "2026-06-22 16:39:42 UTC+8",
    );
});

test("returns empty string for invalid timestamps", () => {
    assert.equal(formatUtc8Timestamp("not-a-date"), "");
});
