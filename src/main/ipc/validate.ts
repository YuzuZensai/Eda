import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { isRecord } from "@shared/validation";

export { isRecord } from "@shared/validation";

function reject(message: ErrorText, suggestedAction: ErrorText): never {
  throw new GitError({
    kind: "invalid-input",
    operation: t("operations.validateRequest"),
    message,
    suggestedAction,
  });
}

export function requireString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== "string") {
    reject(
      errorText("main.validate.mustBeText", { field: field }),
      errorText("main.validate.thisIsABugInEdaPleaseReportIt"),
    );
  }

  const text = value;

  if (text.length === 0) {
    reject(
      errorText("main.validate.isRequired", { field: field }),
      errorText("main.validate.enterAValueFor", { field: field }),
    );
  }

  if (text.length > maxLength) {
    reject(
      errorText("main.validate.isTooLong", { field: field }),
      errorText("main.validate.useCharactersOrFewer", { maxLength: maxLength }),
    );
  }

  if (text.includes("\0")) {
    reject(
      errorText("main.validate.containsANullByte", { field: field }),
      errorText("main.validate.removeTheInvalidCharacter"),
    );
  }

  return text;
}

export function requireId(value: unknown, field = "id"): string {
  const text = requireString(value, field, 64);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text)) {
    reject(
      errorText("main.validate.isNotAValidIdentifier", { field: field }),
      errorText("main.validate.thisIsABugInEdaPleaseReportIt"),
    );
  }
  return text;
}

export function requireAbsolutePath(value: unknown, field = "path"): string {
  const text = requireString(value, field);
  const isAbsolute =
    text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  if (!isAbsolute) {
    reject(
      errorText("main.validate.mustBeAFullPath", { field: field }),
      errorText("main.validate.chooseAFolderUsingTheFolderPicker"),
    );
  }
  return text;
}

export function requireEmail(value: unknown, field = "email"): string {
  const text = requireString(value, field, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    reject(
      errorText("main.validate.thatDoesNotLookLikeAnEmailAddress"),
      errorText("main.validate.enterAnAddressLikeYouExampleCom"),
    );
  }
  return text;
}

export function requireHue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    reject(
      errorText("main.validate.theIdentityColorIsInvalid"),
      errorText("main.validate.pickAColorForThisIdentity"),
    );
  }
  return ((value % 360) + 360) % 360;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 4096,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field, maxLength);
}

export function requireStringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value)) {
    reject(
      errorText("main.validate.mustBeAList", { field: field }),
      errorText("main.validate.thisIsABugInEdaPleaseReportIt"),
    );
  }

  const items: unknown[] = value;

  if (items.length > maxItems) {
    reject(
      errorText("main.validate.hasTooManyEntries", { field: field }),
      errorText("main.validate.useOrFewer", { maxItems: maxItems }),
    );
  }

  return items.map((item, i) => requireString(item, `${field}[${i}]`));
}

export function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    reject(
      errorText("main.validate.isOutsideTheSupportedRange", { field: field }),
      errorText("main.validate.useAWholeNumberFromTo", { minimum: minimum, maximum: maximum }),
    );
  }

  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    reject(
      errorText("main.validate.isInvalid", { label: field }),
      errorText("main.validate.thisIsABugInEdaPleaseReportIt"),
    );
  }
  return value;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    reject(
      errorText("main.validate.isInvalid", { label: label }),
      errorText("main.validate.refreshTheRepositoryAndTryAgain"),
    );
  }
  return value;
}

export function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
