export interface CommandCodeRawModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name: string;
  context_length: number;
  supported_endpoints: string[];
}

export interface CommandCodeModelsResponse {
  object: string;
  data: CommandCodeRawModel[];
}

export interface CommandCodeWhoamiResponse {
  success?: boolean;
  user?: {
    id: string;
    userName?: string;
    name?: string;
    email?: string;
  };
  org?: {
    id: string;
    login?: string;
    name?: string;
  };
  error?: {
    code?: string;
    status?: number;
    message?: string;
  };
}

export interface CommandCodeSubscriptionsResponse {
  success?: boolean;
  data?: {
    planId?: string;
    status?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  };
  error?: string;
}

export interface CommandCodeWindowLimit {
  used: number;
  cap: number;
  /** Epoch milliseconds at which the window resets. */
  resetAt: number;
  exceeded?: boolean;
}

export interface CommandCodeCreditsResponse {
  credits?: {
    planId?: string;
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
    belowThreshold?: boolean;
    creditThreshold?: number;
  };
  /**
   * Rolling rate-limit windows. Returned at the TOP LEVEL of the credits
   * response (not nested under `credits`).
   */
  windowLimits?: {
    limited?: boolean;
    exceeded?: boolean | null;
    fiveHour?: CommandCodeWindowLimit;
    weekly?: CommandCodeWindowLimit;
  };
  sandboxMinutes?: {
    usedMinutes: number;
    limitMinutes: number;
    resetAt?: number;
  } | null;
  sandboxAccess?: boolean;
  error?: string;
}

export interface CommandCodeUsageSummaryResponse {
  totalCount?: number;
  totalCost?: number;
  periodBasis?: string;
  error?: string;
}

export interface AccountBillingInfo {
  planId?: string;
  status?: string;
  monthlyCredits: number;
  purchasedCredits: number;
  freeCredits: number;
  currentPeriodEnd?: string;
  fetchedAt: number;
}
