import { createInstance, type i18n as I18n } from "i18next";
import common from "../locales/en/common.json";
import errors from "../locales/en/errors.json";
import fields from "../locales/en/fields.json";
import main from "../locales/en/main.json";
import operations from "../locales/en/operations.json";
import renderer from "../locales/en/renderer.json";
import shared from "../locales/en/shared.json";
import updateErrors from "../locales/en/update-errors.json";

export const english = {
  ...common,
  ...renderer,
  ...main,
  ...shared,
  ...operations,
  ...fields,
  ...updateErrors,
  ...errors,
};
export type MessageKey = keyof typeof english;
export type MessageValues = Readonly<Record<string, string | number | null | undefined>>;
export type Translator = (key: MessageKey, values?: MessageValues) => string;
export type PluralMessage = Readonly<
  Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }
>;
export type Catalog = Readonly<Partial<Record<MessageKey, string | PluralMessage>>>;

export const catalogs: Readonly<Record<string, Catalog>> = { en: english };
export const supportedLocales = Object.keys(catalogs);

function resources(catalog: Catalog): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, message] of Object.entries(catalog)) {
    if (typeof message === "string") result[key] = message;
    else {
      result[key] = message.other;
      for (const [form, text] of Object.entries(message)) result[`${key}_${form}`] = text;
    }
  }
  return result;
}

function createEngine(language: string, translations: Readonly<Record<string, Catalog>>): I18n {
  const engine = createInstance();
  void engine.init({
    lng: language,
    fallbackLng: "en",
    supportedLngs: Object.keys(translations),
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    resources: Object.fromEntries(
      Object.entries(translations).map(([locale, catalog]) => [
        locale,
        { translation: resources(catalog) },
      ]),
    ),
    interpolation: {
      prefix: "{",
      suffix: "}",
      escapeValue: false,
      skipOnVariables: true,
    },
  });
  return engine;
}

export const i18n = createEngine("en", catalogs);

export function resolveLocale(requested: string | readonly string[]): string {
  const preferences = (typeof requested === "string" ? [requested] : requested).flatMap(
    (language) => {
      try {
        return Intl.getCanonicalLocales(language);
      } catch {
        return [];
      }
    },
  );
  const resolver = i18n.services.languageUtils as {
    getBestMatchFromCodes(languages: string[]): string | undefined;
  };
  return resolver.getBestMatchFromCodes(preferences) ?? "en";
}

export const getLocale = (): string => i18n.resolvedLanguage ?? "en";

export function setLocale(requested: string | readonly string[]): void {
  void i18n.changeLanguage(resolveLocale(requested));
}

export function formatNumber(value: number, language = getLocale()): string {
  return i18n.services.formatter!.format(value, "number", language);
}

function translate(engine: I18n, key: MessageKey, values: MessageValues = {}): string {
  return engine.t(key, {
    ...(typeof values["count"] === "number" ? { count: values["count"] } : {}),
    replace: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        typeof value === "number" ? formatNumber(value, engine.language) : (value ?? ""),
      ]),
    ),
    nest: false,
  });
}

export const t: Translator = (key, values) => translate(i18n, key, values);

export function createTranslator(language: string, catalog: Catalog): Translator {
  const engine = createEngine(language, {
    ...catalogs,
    [language]: language === "en" ? { ...english, ...catalog } : catalog,
  });
  return (key, values) => translate(engine, key, values);
}
