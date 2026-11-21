export const discoveryProviders = ["github", "gitlab"] as const;
export type RepositoryProvider = (typeof discoveryProviders)[number];

export const hostCapabilities = {
  github: {
    host: "github.com",
    authentication: "device-oauth",
    discovery: true,
    pagination: "link",
    commitRoute: "commit",
    treeRoute: "tree",
    remoteTransports: ["https", "ssh"],
  },
  gitlab: {
    host: "gitlab.com",
    authentication: "oauth",
    discovery: true,
    pagination: "next-page",
    commitRoute: "-/commit",
    treeRoute: "-/tree",
    remoteTransports: ["https", "ssh"],
  },
  gitlabSelfHosted: {
    host: null,
    authentication: "token",
    discovery: true,
    pagination: "next-page",
    commitRoute: "-/commit",
    treeRoute: "-/tree",
    remoteTransports: ["https", "ssh"],
  },
  bitbucket: {
    host: "bitbucket.org",
    authentication: "git",
    discovery: false,
    pagination: null,
    commitRoute: "commits",
    treeRoute: "src",
    remoteTransports: ["https", "ssh"],
  },
} as const;

export interface ProviderRepository {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  cloneUrl: string;
  private: boolean;
  archived: boolean;
  updatedAt: string | null;
}

export interface ProviderRepositoryPage {
  repositories: ProviderRepository[];
  nextPage: number | null;
}
