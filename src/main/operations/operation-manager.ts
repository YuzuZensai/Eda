import { redactDiagnostic } from "@shared/diagnostics";
import { errorText } from "@shared/error-codes";
import { errorMessage, GitError } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import type { OperationRecord } from "@shared/operations";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OperationRepository } from "../persistence/operation-repository";

interface RunningOperation {
  record: OperationRecord;
  controller: AbortController;
  hidingPrivateKey?: boolean;
  progressTimer?: ReturnType<typeof setTimeout>;
}

export class OperationManager {
  private readonly context = new AsyncLocalStorage<RunningOperation>();
  private readonly running = new Map<string, RunningOperation>();
  private readonly retries = new Map<string, { profileId: string; work: () => Promise<unknown> }>();
  private readonly listeners = new Set<(record: OperationRecord) => void>();

  constructor(private readonly store: OperationRepository) {
    store.recover();
  }

  get busy(): boolean {
    return this.running.size > 0;
  }

  reset(): void {
    if (this.running.size)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.resetAppData"),
        message: errorText(
          "main.operations.operationManager.finishRunningGitOperationsBeforeResettingEda",
        ),
      });
    this.retries.clear();
  }

  onChange(listener: (record: OperationRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(profileId: string): OperationRecord[] {
    return this.store
      .list(profileId)
      .map((record) => ({ ...record, retryable: this.retries.has(record.id) }));
  }

  private publish(record: OperationRecord) {
    this.store.save(record);
    for (const listener of this.listeners) listener(record);
  }

  get signal(): AbortSignal | undefined {
    return this.context.getStore()?.controller.signal;
  }

  progress(line: string): void {
    const context = this.context.getStore();

    if (!context) return;

    if (context.hidingPrivateKey) {
      if (/-----END [^-]*PRIVATE KEY-----/.test(line)) context.hidingPrivateKey = false;
      return;
    }

    if (
      /-----BEGIN [^-]*PRIVATE KEY-----/.test(line) &&
      !/-----END [^-]*PRIVATE KEY-----/.test(line)
    )
      context.hidingPrivateKey = true;

    context.record.output = redactDiagnostic(`${context.record.output}\n${line}`).slice(-16_000);
    context.record.updatedAt = new Date().toISOString();

    if (!context.progressTimer)
      context.progressTimer = setTimeout(() => {
        delete context.progressTimer;
        this.publish(context.record);
      }, 150);
  }

  attachRepository(repositoryId: string): void {
    const context = this.context.getStore();
    if (context) context.record.repositoryId = repositoryId;
  }

  started(label: string): void {
    const context = this.context.getStore();

    if (!context) return;

    if (context.controller.signal.aborted)
      throw new GitError({
        kind: "cancelled",
        operation: context.record.kind,
        message: errorText(
          "main.operations.operationManager.operationCancelledBeforeTheNextGitCommand",
        ),
      });

    context.record.state = "running";
    context.record.message = redactDiagnostic(label);
    this.publish(context.record);
  }

  async run<T>(
    owner: Pick<OperationRecord, "profileId" | "repositoryId" | "repositoryName">,
    kind: string,
    work: () => Promise<T>,
    retry?: () => Promise<unknown>,
    kindKey?: MessageKey,
  ): Promise<T> {
    const now = new Date().toISOString();
    const record: OperationRecord = {
      ...owner,
      repositoryName: redactDiagnostic(owner.repositoryName),
      id: randomUUID(),
      kind,
      ...(kindKey ? { kindKey } : {}),
      state: "queued",
      startedAt: now,
      updatedAt: now,
      durationMs: 0,
      output: "",
      message: t("main.operations.operationManager.waitingForRepositoryAccess"),
      cancellable: true,
      retryable: false,
    };

    const context: RunningOperation = { record, controller: new AbortController() };

    this.running.set(record.id, context);
    this.publish(record);

    try {
      const result = await this.context.run(context, work);
      record.state = "succeeded";
      record.message = t("main.operationManager.completed");
      return result;
    } catch (error) {
      record.state = context.controller.signal.aborted ? "interrupted" : "failed";
      record.message = errorMessage(
        error,
        errorText("main.operations.operationManager.theOperationFailedUnexpectedly"),
      );
      record.recovery =
        record.state === "interrupted"
          ? t(
              "main.operations.operationManager.refreshAndInspectTheRepositoryBeforeRetryingCancellation",
            )
          : error instanceof GitError
            ? (error.suggestedAction ??
              t("main.operations.operationManager.reviewTheRepositoryStateAndTryAgain"))
            : t("main.operations.operationManager.refreshAndInspectTheRepositoryBeforeTryingAgain");

      if (error instanceof GitError) {
        if (error.exitCode !== undefined) record.exitCode = error.exitCode;
        if (error.rawStderr)
          record.output = redactDiagnostic(`${record.output}\n${error.rawStderr}`).slice(-16_000);
      }

      if (retry && record.state === "failed") {
        record.retryable = true;
        this.retries.set(record.id, { profileId: owner.profileId, work: retry });
        if (this.retries.size > 200) this.retries.delete(this.retries.keys().next().value!);
      }

      throw error;
    } finally {
      clearTimeout(context.progressTimer);
      record.cancellable = false;
      record.updatedAt = new Date().toISOString();
      record.durationMs = Date.now() - Date.parse(record.startedAt);
      this.running.delete(record.id);
      this.publish(record);
      this.store.prune(owner.profileId);
    }
  }

  cancel(profileId: string, id: string): void {
    const context = this.running.get(id);

    if (!context || context.record.profileId !== profileId)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.cancelOperation"),
        message: errorText(
          "main.operations.operationManager.thatOperationIsNoLongerRunningInThisProfile",
        ),
      });

    context.controller.abort();
    context.record.message = t("main.operations.operationManager.cancellationRequested");
    context.record.cancellable = false;
    this.publish(context.record);
  }

  async retry(profileId: string, id: string): Promise<void> {
    const retry = this.retries.get(id);

    if (!retry || retry.profileId !== profileId)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.retryOperation"),
        message: errorText(
          "main.operations.operationManager.reopenTheRepositoryAndRepeatTheActionAfter",
        ),
      });

    this.retries.delete(id);
    await retry.work();
  }
}
