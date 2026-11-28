export interface RepositorySummary {
  id: string;
  identityId: string;
  name: string;
  path: string;
  favourite: boolean;
  lastOpenedAt?: string;
  available: boolean;
  unavailableReason?: string;
  trusted?: boolean;
}

export interface InitRepositoryOptions {
  branch: string;
  readme: boolean;
  ignore: "none" | "node" | "python";
  license: "none" | "MIT";
}

export interface RepositoryTrustRequest {
  id: string;
  path: string;
  reasons?: string[];
}

export interface RepositoryNavigation {
  path: string;
  commit?: string;
  ref?: string;
}
