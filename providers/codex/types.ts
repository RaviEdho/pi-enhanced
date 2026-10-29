export interface RawCodexCatalogModel {
  slug: string;
  display_name?: string;
  priority?: number;
  available_in_plans?: string[];
  supported_in_api?: boolean;
  context_window?: number;
  max_context_window?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: { effort: string; description?: string }[];
  visibility?: string;
}

export interface RawCodexCatalogResponse {
  models?: RawCodexCatalogModel[];
}

export interface CodexModelSummary {
  slug: string;
  displayName: string;
  availableInPlans: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  reasoningLevels?: string[];
  supportedInApi?: boolean;
  visibility?: string;
}

export interface CodexCatalogCache {
  updatedAt: number;
  models: CodexModelSummary[];
}
