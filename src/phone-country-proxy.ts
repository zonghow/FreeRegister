import {randomInt} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {createHeroSmsProvider, type HeroSmsCountry} from "./sms/heroSMS.js";
import type {AppConfig} from "./config.js";

const COUNTRY_CODE_CACHE_VERSION = 1;
const HERO_SMS_COUNTRIES_CACHE_VERSION = 1;
const HERO_SMS_COUNTRIES_CACHE_FILE = path.join(".cache", "hero-sms-countries.json");
const SID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const COUNTRY_CODE_FETCH_TIMEOUT_MS = 10_000;
const HERO_SMS_COUNTRIES_TIMEOUT_MS = 10_000;

export interface CountryCodeRecord {
    code: string;
    name: string;
    zh_name?: string;
    char?: string;
}

export interface PhoneCountryProxyInput {
    countryId?: number;
    countryLabel?: string;
    countryName?: string;
}

export interface PhoneCountryProxyResult {
    proxyUrl: string;
    countryCode: string;
    countryName: string;
    sid: string;
}

interface CachedCountryCodePayload {
    version?: number;
    fetchedAt?: string;
    records?: unknown;
}

interface HeroSmsCountriesCachePayload {
    version?: number;
    fetchedAt?: string;
    countries?: unknown;
}

const STATIC_COUNTRY_CODE_BY_NAME: Record<string, string> = {
    brazil: "BR",
    brunei: "BN",
    "bosnia": "BA",
    "bosnia and herzegovina": "BA",
    "central african republic": "CF",
    chile: "CL",
    colombia: "CO",
    "czech": "CZ",
    "czech republic": "CZ",
    france: "FR",
    germany: "DE",
    "dr congo": "CD",
    "democratic republic of the congo": "CD",
    "guinea-bissau": "GW",
    "guinea bissau": "GW",
    "hong kong": "HK",
    indonesia: "ID",
    "ivory coast": "CI",
    "cote divoire": "CI",
    japan: "JP",
    kenya: "KE",
    macao: "MO",
    macau: "MO",
    morocco: "MA",
    myanmar: "MM",
    "north macedonia": "MK",
    papua: "PG",
    "papua new guinea": "PG",
    philippines: "PH",
    poland: "PL",
    romania: "RO",
    salvador: "SV",
    "el salvador": "SV",
    samoa: "WS",
    "saint vincent and the grenadines": "VC",
    seychelles: "SC",
    taiwan: "TW",
    thailand: "TH",
    "timor-leste": "TL",
    "timor leste": "TL",
    uae: "AE",
    "united arab emirates": "AE",
    uk: "GB",
    "united kingdom": "GB",
    usa: "US",
    "united states": "US",
    "united states of america": "US",
    vietnam: "VN",
    "viet nam": "VN",
};

function firstString(...values: unknown[]): string {
    for (const value of values) {
        const normalized = String(value ?? "").trim();
        if (normalized) return normalized;
    }
    return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCountryName(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeCountryCode(value: unknown): string {
    const code = String(value ?? "").trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : "";
}

function normalizeCountryCodeRecords(value: unknown): CountryCodeRecord[] {
    const source = isRecord(value) && Array.isArray(value.records) ? value.records : value;
    if (!Array.isArray(source)) return [];
    const records: CountryCodeRecord[] = [];
    for (const item of source) {
        if (!isRecord(item)) continue;
        const code = normalizeCountryCode(item.code);
        const name = firstString(item.name);
        if (!code || !name) continue;
        records.push({
            code,
            name,
            zh_name: firstString(item.zh_name, item.zhName) || undefined,
            char: firstString(item.char) || undefined,
        });
    }
    return records;
}

export function extractHeroSmsCountryName(value: unknown): string {
    if (isRecord(value)) {
        const raw = value.raw;
        if (isRecord(raw)) {
            const fromRaw = firstString(raw.eng, raw.title, raw.name_en, raw.name, raw.country, raw.label);
            if (fromRaw) return fromRaw;
        }
        const fromRecord = firstString(value.eng, value.english, value.name, value.label, value.title);
        if (fromRecord) return extractHeroSmsCountryName(fromRecord);
    }

    const label = String(value ?? "").trim();
    if (!label) return "";
    const matches = [...label.matchAll(/\(([^()]+)\)/g)];
    const english = matches.length ? String(matches[matches.length - 1]?.[1] ?? "").trim() : "";
    return english || label;
}

export function countryCodeFromName(name: string, records: CountryCodeRecord[] = []): string {
    const normalizedName = normalizeCountryName(name);
    if (!normalizedName) return "";

    const alias = STATIC_COUNTRY_CODE_BY_NAME[normalizedName];
    if (alias) return alias;

    const upper = normalizeCountryCode(name);
    if (upper) return upper;

    for (const record of records) {
        if (normalizeCountryName(record.name) === normalizedName) return record.code;
        if (record.zh_name && normalizeCountryName(record.zh_name) === normalizedName) return record.code;
    }

    return "";
}

export function generatePhoneCountrySid(length = 8): string {
    let sid = "";
    for (let index = 0; index < length; index += 1) {
        sid += SID_ALPHABET[randomInt(0, SID_ALPHABET.length)];
    }
    return sid;
}

export function renderPhoneCountryProxyTemplate(template: string, code: string, sid = generatePhoneCountrySid()): string {
    const countryCode = normalizeCountryCode(code);
    if (!countryCode) {
        throw new Error(`手机号国家 code 无效: ${code}`);
    }
    const normalizedSid = String(sid ?? "").trim();
    if (!/^[0-9A-Za-z]{8}$/.test(normalizedSid)) {
        throw new Error(`代理 sid 必须是 8 位数字或大小写字母: ${sid}`);
    }
    const proxyUrl = template.replaceAll("{code}", countryCode).replaceAll("{sid}", normalizedSid);
    new URL(proxyUrl);
    return proxyUrl;
}

async function readCountryCodeCache(file: string): Promise<CountryCodeRecord[]> {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as CachedCountryCodePayload | unknown[];
        const records = normalizeCountryCodeRecords(parsed);
        return records;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

async function writeCountryCodeCache(file: string, records: CountryCodeRecord[]): Promise<void> {
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, `${JSON.stringify({
        version: COUNTRY_CODE_CACHE_VERSION,
        fetchedAt: new Date().toISOString(),
        records,
    }, null, 2)}\n`, "utf8");
}

async function fetchCountryCodeRecords(config: AppConfig): Promise<CountryCodeRecord[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COUNTRY_CODE_FETCH_TIMEOUT_MS);
    timeout.unref?.();
    try {
        const response = await fetch(config.proxy.countryCodeUrl, {signal: controller.signal});
        if (!response.ok) {
            throw new Error(`country_code 请求失败: HTTP ${response.status}`);
        }
        const records = normalizeCountryCodeRecords(await response.json());
        if (!records.length) {
            throw new Error("country_code 返回国家列表为空");
        }
        await writeCountryCodeCache(config.proxy.countryCodeCache, records);
        return records;
    } finally {
        clearTimeout(timeout);
    }
}

async function loadCountryCodeRecords(config: AppConfig): Promise<CountryCodeRecord[]> {
    const cached = await readCountryCodeCache(config.proxy.countryCodeCache);
    if (cached.length) return cached;
    return fetchCountryCodeRecords(config);
}

function heroSmsCountriesCachePath(): string {
    return path.resolve(process.cwd(), HERO_SMS_COUNTRIES_CACHE_FILE);
}

function normalizeHeroSmsCountriesFromCache(value: unknown): HeroSmsCountry[] {
    const source = isRecord(value) && Array.isArray(value.countries) ? value.countries : value;
    if (!Array.isArray(source)) return [];
    const countries: HeroSmsCountry[] = [];
    for (const item of source) {
        if (!isRecord(item)) continue;
        const id = Math.floor(Number(item.id));
        if (!Number.isFinite(id) || id <= 0) continue;
        countries.push({
            id,
            label: firstString(item.label) || `Country #${id}`,
            raw: isRecord(item.raw) ? item.raw : item,
        });
    }
    return countries;
}

async function readHeroSmsCountriesCache(): Promise<HeroSmsCountry[]> {
    try {
        const parsed = JSON.parse(await readFile(heroSmsCountriesCachePath(), "utf8")) as HeroSmsCountriesCachePayload;
        if (Number(parsed.version) !== HERO_SMS_COUNTRIES_CACHE_VERSION) return [];
        return normalizeHeroSmsCountriesFromCache(parsed);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        return [];
    }
}

async function writeHeroSmsCountriesCache(countries: HeroSmsCountry[]): Promise<void> {
    if (!countries.length) return;
    const file = heroSmsCountriesCachePath();
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, `${JSON.stringify({
        version: HERO_SMS_COUNTRIES_CACHE_VERSION,
        fetchedAt: new Date().toISOString(),
        countries,
    }, null, 2)}\n`, "utf8");
}

async function fetchHeroSmsCountries(config: AppConfig, smsProxyUrl: string): Promise<HeroSmsCountry[]> {
    const apiKey = config.heroSMS.apiKeys[0] ?? config.heroSMS.apiKey;
    const provider = createHeroSmsProvider({
        apiKey,
        proxyUrl: smsProxyUrl,
        timeoutMs: HERO_SMS_COUNTRIES_TIMEOUT_MS,
        rpsLimit: config.heroSMS.rpsLimit,
        rateLimitLabel: "HeroSMS country-code resolver",
    });
    const countries = await provider.getCountries();
    await writeHeroSmsCountriesCache(countries);
    return countries;
}

async function resolveHeroSmsCountryName(config: AppConfig, input: PhoneCountryProxyInput, smsProxyUrl: string): Promise<string> {
    const fromInput = extractHeroSmsCountryName(input.countryName || input.countryLabel || "");
    if (fromInput) return fromInput;

    const countryId = Math.floor(Number(input.countryId));
    if (!Number.isFinite(countryId) || countryId <= 0) {
        throw new Error("HeroSMS activation 缺少国家 id，无法按手机号国家生成代理");
    }

    const cached = await readHeroSmsCountriesCache();
    const cachedCountry = cached.find((country) => country.id === countryId);
    const cachedName = extractHeroSmsCountryName(cachedCountry);
    if (cachedName) return cachedName;

    const fetched = await fetchHeroSmsCountries(config, smsProxyUrl);
    const fetchedCountry = fetched.find((country) => country.id === countryId);
    const fetchedName = extractHeroSmsCountryName(fetchedCountry);
    if (fetchedName) return fetchedName;

    throw new Error(`HeroSMS country=${countryId} 未能映射到国家名称`);
}

export async function buildPhoneCountryProxy(
    config: AppConfig,
    input: PhoneCountryProxyInput,
    smsProxyUrl = "",
): Promise<PhoneCountryProxyResult> {
    const countryName = await resolveHeroSmsCountryName(config, input, smsProxyUrl);
    let records: CountryCodeRecord[] = [];
    try {
        records = await loadCountryCodeRecords(config);
    } catch {
        records = [];
    }
    const countryCode = countryCodeFromName(countryName, records);
    if (!countryCode) {
        throw new Error(`HeroSMS 国家无法映射到 country_code code: ${countryName}`);
    }
    const sid = generatePhoneCountrySid();
    return {
        proxyUrl: renderPhoneCountryProxyTemplate(config.proxy.phoneCountryTemplate, countryCode, sid),
        countryCode,
        countryName,
        sid,
    };
}
