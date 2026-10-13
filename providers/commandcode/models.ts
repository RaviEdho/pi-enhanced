import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
  API_TIMEOUT_MS,
  COMMANDCODE_ANTHROPIC_BASE_URL,
  COMMANDCODE_PROVIDER_V1_URL,
  COMMANDCODE_USER_AGENT,
  MODELS_URL,
  PROVIDER_ID,
} from "./constants.js";
import type { CommandCodeModelsResponse, CommandCodeRawModel } from "./types.js";

const CACHE_FILE_PATH = join(
  homedir(),
  ".pi/agent/cache/commandcode-models.json"
);

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelMetadata {
  efforts: string[];
  cost: ModelPricing;
}

export const COMMANDCODE_MODEL_METADATA: Record<string, ModelMetadata> = {
  "deepseek/deepseek-v4-pro": {
    "efforts": [
      "off",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.66,
      "output": 1.98,
      "cacheRead": 0.022,
      "cacheWrite": 0
    }
  },
  "deepseek/deepseek-v4-flash": {
    "efforts": [
      "off",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.6,
      "cacheRead": 0.003,
      "cacheWrite": 0
    }
  },
  "deepseek/deepseek-v4-flash-vision-exp": {
    "efforts": [
      "off",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.6,
      "cacheRead": 0.003,
      "cacheWrite": 0
    }
  },
  "deepseek/deepseek-v4-flash-fast": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.28,
      "output": 0.56,
      "cacheRead": 0.07,
      "cacheWrite": 0
    }
  },
  "deepseek/deepseek-v4.1-flash": {
    "efforts": [
      "off",
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.6,
      "cacheRead": 0.003,
      "cacheWrite": 0
    }
  },
  "deepseek/deepseek-v4.1-flash-fast": {
    "efforts": [
      "off",
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.16,
      "output": 0.58,
      "cacheRead": 0.016,
      "cacheWrite": 0
    }
  },
  "moonshotai/Kimi-K3": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 0
    }
  },
  "moonshotai/Kimi-K2.7-Code": {
    "efforts": [],
    "cost": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.19,
      "cacheWrite": 0
    }
  },
  "moonshotai/Kimi-K2.7-Code-Highspeed": {
    "efforts": [],
    "cost": {
      "input": 1.9,
      "output": 8,
      "cacheRead": 0.38,
      "cacheWrite": 0
    }
  },
  "moonshotai/Kimi-K2.6": {
    "efforts": [],
    "cost": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.16,
      "cacheWrite": 0
    }
  },
  "moonshotai/Kimi-K2.5": {
    "efforts": [],
    "cost": {
      "input": 0.6,
      "output": 3,
      "cacheRead": 0.1,
      "cacheWrite": 0
    }
  },
  "z-ai/glm-5.3-flash": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    }
  },
  "z-ai/glm-5.3-flashx": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 0.37,
      "output": 1.25,
      "cacheRead": 0.075,
      "cacheWrite": 0
    }
  },
  "zai-org/GLM-5.3": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "cost": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26,
      "cacheWrite": 0
    }
  },
  "zai-org/GLM-5.2": {
    "efforts": [
      "high",
      "max"
    ],
    "cost": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26,
      "cacheWrite": 0
    }
  },
  "zai-org/GLM-5.2-Fast": {
    "efforts": [],
    "cost": {
      "input": 3,
      "output": 10.25,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "zai-org/GLM-5.1": {
    "efforts": [],
    "cost": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26,
      "cacheWrite": 0
    }
  },
  "zai-org/GLM-5": {
    "efforts": [],
    "cost": {
      "input": 1,
      "output": 3.2,
      "cacheRead": 0.2,
      "cacheWrite": 0
    }
  },
  "MiniMaxAI/MiniMax-M3": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06,
      "cacheWrite": 0
    }
  },
  "MiniMaxAI/MiniMax-M2.7": {
    "efforts": [],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06,
      "cacheWrite": 0
    }
  },
  "MiniMaxAI/MiniMax-M2.5": {
    "efforts": [],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.03,
      "cacheWrite": 0
    }
  },
  "xiaomi/mimo-v2.6-pro": {
    "efforts": [],
    "cost": {
      "input": 0.435,
      "output": 0.87,
      "cacheRead": 0.0036,
      "cacheWrite": 0
    }
  },
  "xiaomi/mimo-v2.6-pro-ultraspeed": {
    "efforts": [],
    "cost": {
      "input": 4.35,
      "output": 8.7,
      "cacheRead": 0.036,
      "cacheWrite": 0
    }
  },
  "xiaomi/mimo-v2.6-flash": {
    "efforts": [],
    "cost": {
      "input": 0.14,
      "output": 0.28,
      "cacheRead": 0.0028,
      "cacheWrite": 0
    }
  },
  "xiaomi/mimo-v2.5-pro": {
    "efforts": [],
    "cost": {
      "input": 0.435,
      "output": 0.87,
      "cacheRead": 0.0036,
      "cacheWrite": 0
    }
  },
  "xiaomi/mimo-v2.5": {
    "efforts": [],
    "cost": {
      "input": 0.14,
      "output": 0.28,
      "cacheRead": 0.0028,
      "cacheWrite": 0
    }
  },
  "Qwen/Qwen3.8-Omni-Flash": {
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "cost": {
      "input": 0.15,
      "output": 0.47,
      "cacheRead": 0.016,
      "cacheWrite": 0
    }
  },
  "Qwen/Qwen3.8-Max-0902": {
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.25,
      "cacheWrite": 0
    }
  },
  "Qwen/Qwen3.8-Max": {
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.25,
      "cacheWrite": 2.5
    }
  },
  "Qwen/Qwen3.8-27B": {
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "cost": {
      "input": 0.4,
      "output": 3,
      "cacheRead": 0.04,
      "cacheWrite": 0
    }
  },
  "Qwen/Qwen3.8-Flash": {
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "cost": {
      "input": 0.16,
      "output": 0.47,
      "cacheRead": 0.016,
      "cacheWrite": 0
    }
  },
  "Qwen/Qwen3.7-Max": {
    "efforts": [],
    "cost": {
      "input": 2.5,
      "output": 7.5,
      "cacheRead": 0.5,
      "cacheWrite": 3.13
    }
  },
  "Qwen/Qwen3.7-Plus": {
    "efforts": [],
    "cost": {
      "input": 0.4,
      "output": 1.6,
      "cacheRead": 0.08,
      "cacheWrite": 0.5
    }
  },
  "Qwen/Qwen3.7-Flash": {
    "efforts": [],
    "cost": {
      "input": 0.03,
      "output": 0.13,
      "cacheRead": 0.006,
      "cacheWrite": 0.038
    }
  },
  "Qwen/Qwen3.6-Max-Preview": {
    "efforts": [],
    "cost": {
      "input": 1.3,
      "output": 7.8,
      "cacheRead": 0.26,
      "cacheWrite": 1.63
    }
  },
  "Qwen/Qwen3.6-Plus": {
    "efforts": [],
    "cost": {
      "input": 0.5,
      "output": 3,
      "cacheRead": 0.1,
      "cacheWrite": 0
    }
  },
  "meituan/LongCat-2.0": {
    "efforts": [],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.006,
      "cacheWrite": 0
    }
  },
  "stepfun/Step-5-Preview": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1,
      "output": 2.7,
      "cacheRead": 0.05,
      "cacheWrite": 0
    }
  },
  "stepfun/Step-3.7-Flash": {
    "efforts": [],
    "cost": {
      "input": 0.2,
      "output": 1.15,
      "cacheRead": 0.04,
      "cacheWrite": 0
    }
  },
  "stepfun/Step-3.5-Flash": {
    "efforts": [],
    "cost": {
      "input": 0.09,
      "output": 0.3,
      "cacheRead": 0.02,
      "cacheWrite": 0
    }
  },
  "tencent/hy3-paid": {
    "efforts": [],
    "cost": {
      "input": 0.14,
      "output": 0.58,
      "cacheRead": 0.035,
      "cacheWrite": 0
    }
  },
  "tencent/hy4-preview": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0.834,
      "output": 2.501,
      "cacheRead": 0.042,
      "cacheWrite": 0
    }
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    "efforts": [],
    "cost": {
      "input": 0.6,
      "output": 2.4,
      "cacheRead": 0.12,
      "cacheWrite": 0
    }
  },
  "thinkingmachines/inkling": {
    "efforts": [],
    "cost": {
      "input": 1,
      "output": 4.05,
      "cacheRead": 0.17,
      "cacheWrite": 0
    }
  },
  "thinkingmachines/inkling-small": {
    "efforts": [],
    "cost": {
      "input": 0.5,
      "output": 1.2,
      "cacheRead": 0.1,
      "cacheWrite": 0
    }
  },
  "poolside/laguna-s-2.1-free": {
    "efforts": [],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  },
  "inclusionai/ling-3.0-flash-sante:free": {
    "efforts": [],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  },
  "inclusionai/ling-3.1-flash:free": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  },
  "mistral/mistral-large-4": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1.36,
      "output": 4.18,
      "cacheRead": 0.14,
      "cacheWrite": 0
    }
  },
  "stealth/glyph-cluster:free": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  },
  "claude-sonnet-5-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5
    }
  },
  "claude-sonnet-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    }
  },
  "claude-sonnet-4-6": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    }
  },
  "claude-fable-5-1": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 0.25,
      "cacheWrite": 12.5
    }
  },
  "claude-fable-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    }
  },
  "claude-opus-5-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 4,
      "output": 20,
      "cacheRead": 0.2,
      "cacheWrite": 5
    }
  },
  "claude-opus-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    }
  },
  "claude-opus-4-8": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    }
  },
  "claude-opus-4-7": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    }
  },
  "claude-haiku-5-5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.5,
      "cacheRead": 0.01,
      "cacheWrite": 0.125
    }
  },
  "claude-haiku-4-5-20251001": {
    "efforts": [],
    "cost": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheWrite": 1.25
    }
  },
  "gpt-6-astra": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5
    }
  },
  "gpt-6.1-sol": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5
    }
  },
  "gpt-6-sol": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    }
  },
  "gpt-6-luna": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.5,
      "cacheRead": 0.01,
      "cacheWrite": 0.125
    }
  },
  "gpt-5.6-sol": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    }
  },
  "gpt-5.6-terra": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    }
  },
  "gpt-5.6-luna": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25
    }
  },
  "gpt-5.5": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "gpt-5.4": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 2.5,
      "output": 15,
      "cacheRead": 0.25,
      "cacheWrite": 0
    }
  },
  "gpt-5.3-codex": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 2,
      "output": 8,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "gpt-5.4-mini": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0.75,
      "output": 4.5,
      "cacheRead": 0.075,
      "cacheWrite": 0
    }
  },
  "google/gemini-4-argon": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 0
    }
  },
  "google/gemini-3.8-flash": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1.5,
      "output": 7.5,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "google/gemini-3.7-flash": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1.5,
      "output": 7.5,
      "cacheRead": 0.15,
      "cacheWrite": 0.08334
    }
  },
  "google/gemini-3.6-flash": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1.5,
      "output": 7.5,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "google/gemini-3.5-flash": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "google/gemini-3.5-flash-lite": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0.3,
      "output": 2.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    }
  },
  "google/gemini-3.1-flash-lite": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 0.25,
      "output": 1.5,
      "cacheRead": 0.03,
      "cacheWrite": 0
    }
  },
  "sakana/fugu-ultra": {
    "efforts": [
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "meta/muse-spark-1.1": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 1.25,
      "output": 4.25,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "meta/muse-spark-1.2": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 1.25,
      "output": 4.25,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "meta/muse-spark-1.2-contributor": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.2,
      "cacheRead": 0.002,
      "cacheWrite": 0
    }
  },
  "meta/muse-spark-1.3": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "cost": {
      "input": 1.25,
      "output": 4.25,
      "cacheRead": 0.15,
      "cacheWrite": 0
    }
  },
  "meta/muse-spark-1.3-contributor": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 0.1,
      "output": 0.2,
      "cacheRead": 0.002,
      "cacheWrite": 0
    }
  },
  "meta/muse-wonder-1.0": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 4,
      "output": 20,
      "cacheRead": 0.2,
      "cacheWrite": 0
    }
  },
  "xai/grok-4.5": {
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "xai/grok-4.6": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  },
  "xai/grok-4.7": {
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "cost": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "cacheWrite": 0
    }
  }
};

export function buildThinkingLevelMap(efforts?: string[]): ThinkingLevelMap | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  const set = new Set(efforts);
  return {
    off: set.has("off") ? "off" : null,
    minimal: null,
    low: set.has("low") ? "low" : null,
    medium: set.has("medium") ? "medium" : null,
    high: set.has("high") ? "high" : null,
    xhigh: set.has("xhigh") ? "xhigh" : null,
    max: set.has("max") ? "max" : null,
  };
}

function resolveMaxTokens(contextLength: number): number {
  if (contextLength >= 1000000) return 32768;
  if (contextLength >= 256000) return 16384;
  return 8192;
}

export const DEFAULT_COMMANDCODE_MODELS: Model<any>[] = [
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_ANTHROPIC_BASE_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: {
      supportsEagerToolInputStreaming: true,
      supportsCacheControlOnTools: true,
    },
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: "off",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
    contextWindow: 1050000,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1050000,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "Qwen/Qwen3.8-Max",
    name: "Qwen 3.8 Max",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  },
];

export function transformCommandCodeModel(raw: CommandCodeRawModel): Model<any> | null {
  if (raw.id.includes("jev") || raw.supported_endpoints.includes("/systemone")) {
    return null;
  }

  const isAnthropic = raw.supported_endpoints.includes("/messages");
  const maxTokens = resolveMaxTokens(raw.context_length);
  const meta = COMMANDCODE_MODEL_METADATA[raw.id];
  const thinkingMap = buildThinkingLevelMap(meta?.efforts);
  const reasoning = Boolean(thinkingMap || meta?.efforts?.length);

  const cost: ModelPricing = meta?.cost || {
    input: 0.5,
    output: 2.0,
    cacheRead: 0.05,
    cacheWrite: 0,
  };

  if (isAnthropic) {
    return {
      id: raw.id,
      name: raw.name || raw.id,
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: COMMANDCODE_ANTHROPIC_BASE_URL,
      headers: { "User-Agent": COMMANDCODE_USER_AGENT },
      reasoning,
      ...(thinkingMap ? { thinkingLevelMap: thinkingMap } : {}),
      input: ["text", "image"],
      cost,
      contextWindow: raw.context_length,
      maxTokens,
      compat: {
        supportsEagerToolInputStreaming: true,
        supportsCacheControlOnTools: true,
      },
    };
  }

  return {
    id: raw.id,
    name: raw.name || raw.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: COMMANDCODE_PROVIDER_V1_URL,
    headers: { "User-Agent": COMMANDCODE_USER_AGENT },
    reasoning,
    ...(thinkingMap ? { thinkingLevelMap: thinkingMap } : {}),
    input: ["text", "image"],
    cost,
    contextWindow: raw.context_length,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: raw.id.toLowerCase().includes("deepseek") ? "deepseek" : undefined,
      maxTokensField: "max_tokens",
    },
  };
}

export function loadCachedModels(): Model<any>[] | null {
  try {
    if (!existsSync(CACHE_FILE_PATH)) return null;
    const content = readFileSync(CACHE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(content) as Model<any>[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function cacheModels(models: Model<any>[]): void {
  try {
    mkdirSync(dirname(CACHE_FILE_PATH), { recursive: true });
    writeFileSync(CACHE_FILE_PATH, JSON.stringify(models, null, 2), "utf-8");
  } catch {
    // Non-fatal cache write error
  }
}

export async function fetchCommandCodeModels(
  apiKey?: string,
  signal?: AbortSignal
): Promise<Model<any>[] | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers: Record<string, string> = {
      "User-Agent": COMMANDCODE_USER_AGENT,
      Accept: "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(MODELS_URL, {
      method: "GET",
      headers,
      signal: combinedSignal,
    });

    if (!res.ok) {
      return null;
    }

    const payload = (await res.json()) as CommandCodeModelsResponse;
    if (!payload?.data || !Array.isArray(payload.data)) {
      return null;
    }

    const models: Model<any>[] = [];
    for (const raw of payload.data) {
      const model = transformCommandCodeModel(raw);
      if (model) {
        models.push(model);
      }
    }

    if (models.length > 0) {
      cacheModels(models);
      return models;
    }
    return null;
  } catch {
    return null;
  }
}
