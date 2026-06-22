import assert from "node:assert/strict";
import test from "node:test";
import {findLatestVerificationMail} from "../src/mail/verification-matcher.js";

test("verification code cache evicts old mailbox entries", () => {
    const originalEmail = "first@example.com";
    const originalMail = {
        recipient: originalEmail,
        content: "Your OpenAI verification code is 123456.",
        timestamp: 1,
    };

    assert.equal(findLatestVerificationMail([originalMail], {targetEmail: originalEmail})?.verificationCode, "123456");
    assert.equal(findLatestVerificationMail([originalMail], {targetEmail: originalEmail}), null);

    for (let index = 0; index < 1005; index += 1) {
        const code = String(200000 + index).padStart(6, "0");
        const email = `user-${index}@example.com`;
        assert.equal(
            findLatestVerificationMail([{
                recipient: email,
                content: `Your OpenAI verification code is ${code}.`,
                timestamp: index + 2,
            }], {targetEmail: email})?.verificationCode,
            code,
        );
    }

    assert.equal(findLatestVerificationMail([originalMail], {targetEmail: originalEmail})?.verificationCode, "123456");
});
