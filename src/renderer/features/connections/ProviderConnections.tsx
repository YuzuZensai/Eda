import { AdditionalGitHosts } from "./AdditionalGitHosts";
import { GitHubConnection } from "./GitHubConnection";
import { GitLabConnection } from "./GitLabConnection";
import { GitLabSelfHostedConnection } from "./GitLabSelfHostedConnection";

export function ProviderConnections({ profileId }: { profileId: string }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] items-start gap-3">
        <GitHubConnection profileId={profileId} />
        <GitLabConnection profileId={profileId} />
        <GitLabSelfHostedConnection key={`gitlab-self-hosted:${profileId}`} profileId={profileId} />
      </div>

      <AdditionalGitHosts key={profileId} profileId={profileId} />
    </div>
  );
}
