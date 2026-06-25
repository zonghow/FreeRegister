import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {hotmailOtpResendAttempt, protectImapClient} from "../src/mail/hotmail.js";

test("hotmail OTP resend is attempted halfway through polling", () => {
    assert.equal(hotmailOtpResendAttempt(45), 23);
    assert.equal(hotmailOtpResendAttempt(10), 5);
    assert.equal(hotmailOtpResendAttempt(1), 1);
});

test("imap client errors reject the active operation instead of being unhandled", async () => {
    const client = new EventEmitter();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
        warnings.push(String(message));
    };
    const guarded = protectImapClient(client, "test-client");
    const socketError = new Error("Socket timeout");

    try {
        setImmediate(() => client.emit("error", socketError));

        await assert.rejects(
            guarded.race(new Promise(() => {}), undefined),
            /Socket timeout/,
        );
        assert.equal(guarded.lastError, socketError);
        assert.match(warnings.join("\n"), /Hotmail IMAP error .*Socket timeout/);
    } finally {
        console.warn = originalWarn;
    }
});

test("late imap client errors remain handled after close", () => {
    const client = new EventEmitter();
    const originalWarn = console.warn;
    console.warn = () => {};
    const guarded = protectImapClient(client, "test-client");

    try {
        guarded.close();

        assert.doesNotThrow(() => client.emit("error", new Error("late tls error")));
    } finally {
        console.warn = originalWarn;
    }
});
