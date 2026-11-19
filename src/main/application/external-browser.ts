import { errorText } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import { homedir } from "node:os";
import type { NodeProcessRunner } from "../git/execution/node-process-runner";
import type { SettingsRepository } from "../persistence/settings-repository";

export class ExternalBrowser {
  constructor(
    private readonly preferences: Pick<SettingsRepository, "resolve">,
    private readonly runner: Pick<NodeProcessRunner, "launch" | "run">,
    private readonly openDefault: (url: string) => Promise<void>,
    private readonly platform = process.platform,
  ) {}

  async open(url: string, profileId?: string): Promise<void> {
    let target: URL;

    try {
      target = new URL(url);
    } catch {
      throw new AppError(errorText("main.browser.invalidUrl"));
    }

    if (
      url.length > 16384 ||
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new AppError(errorText("main.browser.invalidUrl"));

    const executable = this.preferences.resolve(
      "browserExecutable",
      profileId ? { profileId } : {},
    ).value;

    try {
      if (!executable) {
        await this.openDefault(url);
        return;
      }

      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );

      if (this.platform === "darwin" && executable.endsWith(".app")) {
        const result = await this.runner.run({
          executable: "/usr/bin/open",
          args: ["-a", executable, url],
          env,
          signal: AbortSignal.timeout(10_000),
          maxStdoutBytes: 4096,
          maxStderrBytes: 4096,
        });

        if (result.exitCode !== 0 || result.cancelled || result.outputLimitExceeded)
          throw new AppError(errorText("main.browser.openFailed"));
      } else {
        await this.runner.launch(executable, [url], homedir(), env);
      }
    } catch {
      throw new AppError(errorText("main.browser.openFailed"));
    }
  }
}
