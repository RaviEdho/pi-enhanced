export interface CommitProposal {
  type: string;
  scope?: string;
  subject: string;
  body?: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStagedOverview {
  stagedFiles: string[];
  statSummary: string;
}
