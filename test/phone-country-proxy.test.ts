import assert from "node:assert/strict";
import test from "node:test";
import {
    countryCodeFromName,
    extractHeroSmsCountryName,
    generatePhoneCountrySid,
    renderPhoneCountryProxyTemplate,
    type CountryCodeRecord,
} from "../src/phone-country-proxy.js";

const records: CountryCodeRecord[] = [
    {code: "BR", name: "Brazil"},
    {code: "CO", name: "Colombia"},
    {code: "GB", name: "United Kingdom"},
    {code: "AE", name: "United Arab Emirates"},
    {code: "HK", name: "Hong Kong"},
    {code: "TW", name: "Taiwan"},
];

test("maps HeroSMS country names to country_code codes", () => {
    assert.equal(countryCodeFromName("Brazil", records), "BR");
    assert.equal(countryCodeFromName("Colombia", records), "CO");
    assert.equal(countryCodeFromName("USA", records), "US");
    assert.equal(countryCodeFromName("United Kingdom", records), "GB");
    assert.equal(countryCodeFromName("UAE", records), "AE");
    assert.equal(countryCodeFromName("DR Congo", records), "CD");
    assert.equal(countryCodeFromName("Hong Kong", records), "HK");
    assert.equal(countryCodeFromName("Taiwan", records), "TW");
    assert.equal(countryCodeFromName("Myanmar", records), "MM");
});

test("extracts the English HeroSMS country name from labels and raw records", () => {
    assert.equal(extractHeroSmsCountryName("哥伦比亚 (Colombia)"), "Colombia");
    assert.equal(extractHeroSmsCountryName("美国（物理) (USA)"), "USA");
    assert.equal(extractHeroSmsCountryName({id: 33, label: "哥伦比亚 (Colombia)", raw: {eng: "Colombia"}}), "Colombia");
});

test("renders phone-country proxy template with a fresh alphanumeric sid", () => {
    const sid = generatePhoneCountrySid();
    assert.match(sid, /^[0-9A-Za-z]{8}$/);

    const proxy = renderPhoneCountryProxyTemplate(
        "socks5://user-region-{code}-sid-{sid}:pass@example.com:3010",
        "br",
        "aB0123zZ",
    );
    assert.equal(proxy, "socks5://user-region-BR-sid-aB0123zZ:pass@example.com:3010");
});
