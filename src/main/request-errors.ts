import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";

export function missingIdentity(operation: string): GitError {
  return new GitError({
    kind: "invalid-input",
    operation,
    message: errorText("main.requestErrors.thatIdentityNoLongerExists"),
    suggestedAction: errorText("main.requestErrors.refreshTheIdentityListAndTryAgain"),
  });
}

export function invalidRequest(message: ErrorText): GitError {
  return new GitError({
    kind: "invalid-input",
    operation: t("operations.validateRequest"),
    message,
    suggestedAction: errorText("main.requestErrors.refreshTheRepositoryAndTryAgain"),
  });
}
