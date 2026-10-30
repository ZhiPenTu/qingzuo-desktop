export const DEFAULT_PROXY_ADDRESS = 'http://127.0.0.1:8317';

export interface AIProvider {
  id: 'deepseek' | 'openai' | 'siliconflow';
  name: string;
  description: string;
  address: string;
  keyUrl: string;
  preferredModels: string[];
  modelLabels: Record<string, string>;
}

export interface AIModel {
  id: string;
  title?: string;
  type?: string;
}

export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: '适合日常对话与工具调用',
    address: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    preferredModels: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-chat'],
    modelLabels: {
      'deepseek-flash': 'DeepSeek Flash',
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-chat': 'DeepSeek Chat',
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: '能力全面，适合复杂任务',
    address: 'https://api.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    preferredModels: ['gpt-5.4-mini', 'gpt-5.4'],
    modelLabels: {
      'gpt-5.4-mini': 'GPT-5.4 mini',
      'gpt-5.4': 'GPT-5.4',
    },
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    description: '一个密钥使用多种开源模型',
    address: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    preferredModels: ['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4.1-Flash'],
    modelLabels: {
      'deepseek-ai/DeepSeek-V4-Flash': 'DeepSeek V4 Flash',
      'deepseek-ai/DeepSeek-V4.1-Flash': 'DeepSeek V4.1 Flash',
    },
  },
];

export function normalizeAIAddress(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/+$/, '').replace(/\/v1$/i, '');
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\/v1$/i, '');
  }
}

export function providerForAddress(address: string) {
  const normalized = normalizeAIAddress(address);
  return AI_PROVIDERS.find(provider => normalizeAIAddress(provider.address) === normalized) ?? null;
}

export function isChatModel(model: AIModel) {
  const signature = `${model.id} ${model.title ?? ''} ${model.type ?? ''}`.toLowerCase();
  return !/(?:^|[/_. -])(?:embedding|embed|rerank|reranker|bge|whisper|transcri(?:be|ption)|speech|audio|tts|video|sora|veo|kling|imagen|dall-e|stable-diffusion|flux)(?:$|[/_. -])|gpt[-_ ]?image|nano[-_ ]?banana|image[-_ ]?generat/i.test(signature);
}

function humanizeModelId(model: string) {
  const name = model.split('/').pop() ?? model;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => /^gpt$/i.test(part) || /^deepseek$/i.test(part) ? part.toUpperCase() : /^v?\d/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function friendlyModelName(address: string, model: string) {
  const provider = providerForAddress(address);
  if (!provider || !model) return model;
  return provider.modelLabels[model] ?? humanizeModelId(model);
}

export function assistantModelLabel(address: string, model: string) {
  if (!model) return '尚未选择模型';
  const provider = providerForAddress(address);
  return provider ? `${provider.name} · ${friendlyModelName(address, model)}` : model;
}
