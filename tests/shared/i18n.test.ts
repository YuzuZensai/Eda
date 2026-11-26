import { afterEach, describe, expect, it } from "vitest";
import { builtInSetting, validateSetting } from "@shared/preferences/settings";
import {
  createTranslator,
  getLocale,
  resolveLocale,
  setLocale,
  t,
  type Catalog,
  type MessageKey,
} from "@shared/i18n";

afterEach(() => setLocale("en"));

describe("localization", () => {
  it("negotiates ordered system languages and safely falls back for invalid tags", () => {
    expect(resolveLocale(["xx-YY", "en-GB"])).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale(["not_a_locale", ""])).toBe("en");
    expect(resolveLocale([])).toBe("en");
    setLocale("en-AU");
    expect(getLocale()).toBe("en");
  });

  it("persists only supported language choices at application scope", () => {
    expect(builtInSetting("language").value).toBe("system");
    expect(() => validateSetting("language", { kind: "application" }, "en")).not.toThrow();
    expect(() => validateSetting("language", { kind: "application" }, "xx")).toThrow();
    expect(() => validateSetting("language", { kind: "profile", profileId: "p" }, "en")).toThrow();
  });

  it("uses partial translated catalogs and English messages with English fallback grammar", () => {
    const french: Catalog = {
      "common.cancel": "Annuler",
      "profilesSettings.profileCount": { one: "{count} profil", other: "{count} profils" },
    };
    const fr = createTranslator("fr", french);
    expect(fr("common.cancel")).toBe("Annuler");
    expect(fr("common.close")).toBe("Close");
    expect(fr("profilesSettings.profileCount", { count: 0 })).toBe("0 profil");
    expect(fr("profilesSettings.profileCount", { count: 2 })).toBe("2 profils");
    expect(fr("repositoryHome.profileRepositoryCount", { name: "Eda", count: 0 })).toBe(
      "Eda, 0 repositories",
    );
  });

  it("selects plural categories beyond one and other", () => {
    const arabic: Catalog = {
      "profilesSettings.profileCount": {
        zero: "zero {count}",
        one: "one {count}",
        two: "two {count}",
        few: "few {count}",
        many: "many {count}",
        other: "other {count}",
      },
    };
    const ar = createTranslator("ar", arabic);
    const number = (value: number) => new Intl.NumberFormat("ar").format(value);
    expect(ar("profilesSettings.profileCount", { count: 0 })).toBe(`zero ${number(0)}`);
    expect(ar("profilesSettings.profileCount", { count: 2 })).toBe(`two ${number(2)}`);
    expect(ar("profilesSettings.profileCount", { count: 7 })).toBe(`few ${number(7)}`);
    expect(ar("profilesSettings.profileCount", { count: 15 })).toBe(`many ${number(15)}`);
  });

  it("interpolates named values once and formats numeric values in the target locale", () => {
    const de = createTranslator("de-DE", {
      "common.cancel": "{name} to {name}, {count}",
      "common.close": "{missing} {empty}",
      "common.save": "{baseToken}",
    });
    expect(de("common.cancel", { name: "{count}", count: 1234 })).toBe("{count} to {count}, 1.234");
    expect(de("common.close", { empty: null })).toBe("{missing} ");
    expect(de("common.save", { baseToken: "{base}" })).toBe("{base}");
    expect(t("profilesSettings.profileCount", { count: 1 })).toBe("1 profile");
    expect(t("profilesSettings.profileCount", { count: 0 })).toBe("0 profiles");
    expect(t("unknown.key" as MessageKey)).toBe("unknown.key");
  });

  it("keeps interpolation values from changing lookup options or executing nested translations", () => {
    const translate = createTranslator("en", {
      "common.cancel": "{lng} {ns} {defaultValue} {value}",
    });
    expect(
      translate("common.cancel", {
        lng: "fr",
        ns: "other",
        defaultValue: "replacement",
        value: "$t(common.close)",
      }),
    ).toBe("fr other replacement $t(common.close)");
  });
});
