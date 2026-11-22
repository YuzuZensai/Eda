import { GitHubIcon } from "../../components/ui/icons";
import gitlab from "../../assets/providers/gitlab.svg";
import bitbucket from "../../assets/providers/bitbucket.svg";
import azureDevOps from "../../assets/providers/azuredevops.svg";
import { cx } from "../../components/ui/cx";

const PROVIDERS = {
  GitLab: { icon: gitlab, color: "text-[#fc6d26]" },
  "GitLab Self-Hosted": { icon: gitlab, color: "text-[#fc6d26]" },
  Bitbucket: { icon: bitbucket, color: "text-[#2684ff]" },
  "Azure DevOps": { icon: azureDevOps, color: "text-[#2684ff]" },
} as const;

export type HostingProvider = keyof typeof PROVIDERS | "GitHub" | "GitHub Enterprise";

export function ProviderIcon({ provider }: { provider: HostingProvider }) {
  if (provider === "GitHub" || provider === "GitHub Enterprise")
    return (
      <GitHubIcon title="" size={16} className="shrink-0 text-text-primary" aria-hidden="true" />
    );

  const { icon, color } = PROVIDERS[provider];
  const mask = `url("${icon}") center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block size-4 shrink-0 bg-current", color)}
      style={{ mask, WebkitMask: mask }}
    />
  );
}
