export interface KenariRawPricing {
  currency: string;
  free: boolean;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  unit: string;
}

export interface KenariPricingLine {
  billable: string;
  endpoint: string;
  micro_idr: number;
  unit: string;
  variant: string | null;
}

export interface KenariRawModel {
  id: string;
  name: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  pricing?: KenariRawPricing;
  pricing_lines?: KenariPricingLine[];
  endpoints?: string[];
  protocols?: string[];
  reasoning?: boolean;
  reasoning_toggle?: boolean;
  reasoning_options?: string[];
  supported_reasoning_levels?: string[];
  sunset_at?: number | null;
  tool_call?: boolean;
}

export interface KenariModelsResponse {
  object?: string;
  data: KenariRawModel[];
}

export interface KenariPublicPricingResponse {
  usd_idr_rate?: number;
  free_tier?: {
    daily?: number;
    rpm?: number;
    threshold_idr?: number;
    next?: {
      daily?: number;
      rpm?: number;
    };
    plan?: {
      daily?: number;
      rpm?: number;
    };
    referral_cashback_pct?: number;
  };
  items?: Array<{
    free?: boolean;
    input_modalities?: string[];
    endpoints?: string[];
    [key: string]: unknown;
  }>;
}

export interface KenariQuotaWindow {
  budget_rp: number;
  used_rp: number;
  remaining_rp: number;
  used_frac: number;
  resets_at: string;
}

export interface KenariQuotaPlan {
  name: string;
  windows: {
    five_hour?: KenariQuotaWindow;
    week?: KenariQuotaWindow;
    month?: KenariQuotaWindow;
    [key: string]: KenariQuotaWindow | undefined;
  };
}

export interface KenariQuotaCoupon {
  name: string;
  used_rp: number;
  remaining_rp: number | null;
  expires_at: string;
  scope_models?: string[];
}

export interface KenariQuotaResponse {
  plan: KenariQuotaPlan | null;
  coupon: KenariQuotaCoupon | null;
  alert_pct: number;
}

export interface KenariPlan {
  id: string;
  name: string;
  price_idr: number;
  budget_5h_micro_idr?: number;
  budget_week_micro_idr?: number;
  budget_month_micro_idr?: number;
  scope_models?: string[];
  free_cache_models?: string[];
  referral_cashback_pct?: number;
  scope_discounts?: Record<string, number>;
  web_search_daily?: number;
  weekly_reset?: boolean;
}

export interface KenariAccountBilling {
  planId?: string;
  planName?: string;
  availableMicroIdr: number;
  hasBalance: boolean;
  couponScope?: string[];
  fetchedAt: number;
}

export interface KenariBalanceResponse {
  object: string;
  balance_micro_idr: number;
  reserved_micro_idr: number;
  available_micro_idr: number;
  currency: string;
}

export interface KenariCliTokenResponse {
  key: string;
  prefix?: string;
}
