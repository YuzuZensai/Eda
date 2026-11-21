import type { GitHost } from "../integrations/git-host";
import { hostCapabilities } from "../integrations/provider-repositories";
import { isGitLabInstanceHttps } from "../integrations/gitlab-self-hosted";

export type ReferenceLinkKind = "commit" | "branch" | "remote-branch" | "tag";

export function referenceLink(
  remote: string,
  kind: ReferenceLinkKind,
  name: string,
  gitlabInstances: readonly string[] = [],
  gitHosts: readonly GitHost[] = [],
): string | null {
  try {
    const input = remote.replace(/^git@([^:]+):/, "https://$1/");
    const url = new URL(input);

    const selfHosted =
      url.protocol === "https:" &&
      gitlabInstances.some((baseUrl) => isGitLabInstanceHttps(input, baseUrl));

    if (/[\x00-\x20]/.test(name)) return null;
    const cleanPath = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    const hosted = gitHosts.find((account) =>
      ("https://" + url.host + cleanPath).startsWith(account.base + "/"),
    );
    if (
      hosted &&
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^(?:[\w./-]|%20)+$/.test(cleanPath)
    ) {
      const ref = encodeURIComponent(name);
      const web = "https://" + url.host + cleanPath;
      if (hosted.kind === "github-enterprise")
        return web + (kind === "commit" ? "/commit/" : "/tree/") + ref;
      if (hosted.kind === "azure")
        return kind === "commit"
          ? web + "/commit/" + ref
          : web + "?version=" + (kind === "tag" ? "GT" : "GB") + ref;
      if (hosted.kind === "bitbucket-server") {
        const match = /^\/scm\/([\w.-]+)\/([\w.-]+)$/.exec(web.slice(hosted.base.length));
        if (!match) return null;
        const root = hosted.base + "/projects/" + match[1] + "/repos/" + match[2];
        return kind === "commit"
          ? root + "/commits/" + ref
          : root +
              "/browse?at=" +
              encodeURIComponent((kind === "tag" ? "refs/tags/" : "refs/heads/") + name);
      }
    }
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      (url.port && !selfHosted) ||
      /[\x00-\x20]/.test(name)
    )
      return null;

    const path = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");

    if (!/^\/[\w.-]+\/[\w./-]+$/.test(path)) return null;

    const ref = encodeURIComponent(name);

    const host = selfHosted
      ? hostCapabilities.gitlabSelfHosted
      : Object.values(hostCapabilities).find((entry) => entry.host === url.hostname);
    if (!host || !host.remoteTransports.some((transport) => transport + ":" === url.protocol))
      return null;
    const route = kind === "commit" ? host.commitRoute : host.treeRoute;
    return `https://${url.host}${path}/${route}/${ref}`;
  } catch {
    return null;
  }
}
