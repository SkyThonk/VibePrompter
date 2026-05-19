import type { ReactNode } from 'react';

export type SettingsTabId =
  | 'general'
  | 'shortcuts'
  | 'modes'
  | 'providers'
  | 'history'
  | 'appearance'
  | 'advanced'
  | 'about';

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  iconName: string;
}

export interface PromptMode {
  id: string;
  name: string;
  desc: string;
  sys: string;
  temp: number;
  maxTok: number;
  provider: string | null;
  iconName: string;
}

export interface ProviderInfo {
  id: 'openai' | 'anthropic' | 'gemini' | 'ollama';
  name: string;
  accent: string;
  status: 'ok' | 'idle';
  model: string;
  usage: number;
  local?: boolean;
}

export interface OllamaModel {
  name: string;
  size: string;
  active: boolean;
  pulled: string;
}

export interface HistoryItem {
  id: number;
  mode: string;
  iconName: string;
  provider: string;
  /** RFC3339 timestamp of when the run finished. Display via relativeTime(). */
  createdAt: string;
  ms: number;
  src: string;
  out: string;
  fav: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ShortcutItem {
  id: string;
  label: string;
  hint: string;
  iconName: string;
  accelerator: string;
  action: string;
  enabled: boolean;
  keys: string[];
}

export type Lazy<T> = () => T;
export type IconRenderer = ReactNode;
