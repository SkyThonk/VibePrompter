// Where to get an API key for each vendor preset, plus which vendors offer a
// usable no-cost path. Kept in one place so the onboarding screen and the
// Providers settings editor link to the same URLs and never drift.
//
// Keyed by the same preset ids used in `SetupScreen` and
// `providers/connection.ts` (openai, anthropic, openrouter, groq, …).

export interface ProviderLink {
  /** Direct page where the user can create / copy an API key. Empty for
   *  local servers (Ollama, LM Studio) that need no key. */
  keysUrl: string;
  /** Short note shown when the vendor has a free tier. Undefined = paid only. */
  freeTier?: string;
}

export const PROVIDER_LINKS: Record<string, ProviderLink> = {
  openai:     { keysUrl: 'https://platform.openai.com/api-keys' },
  anthropic:  { keysUrl: 'https://console.anthropic.com/settings/keys' },
  openrouter: { keysUrl: 'https://openrouter.ai/keys', freeTier: 'Many models tagged ":free" run at no cost.' },
  groq:       { keysUrl: 'https://console.groq.com/keys', freeTier: 'Generous free tier — no card required.' },
  mistral:    { keysUrl: 'https://console.mistral.ai/api-keys', freeTier: 'Free "Experiment" tier available.' },
  deepseek:   { keysUrl: 'https://platform.deepseek.com/api_keys' },
  together:   { keysUrl: 'https://api.together.xyz/settings/api-keys' },
  gemini:     { keysUrl: 'https://aistudio.google.com/apikey', freeTier: 'Google AI Studio gives a free key with daily limits.' },
  xai:        { keysUrl: 'https://console.x.ai' },
  ollama:     { keysUrl: '' },
  lmstudio:   { keysUrl: '' },
};

/** Vendors with a genuine no-cost path — surfaced as a "start free" hint for
 *  users who don't have any API key yet. Order = what we recommend trying. */
export const FREE_KEY_PROVIDERS: { id: string; label: string; url: string }[] = [
  { id: 'groq', label: 'Groq Cloud', url: PROVIDER_LINKS.groq.keysUrl },
  { id: 'gemini', label: 'Google AI Studio', url: PROVIDER_LINKS.gemini.keysUrl },
  { id: 'openrouter', label: 'OpenRouter', url: PROVIDER_LINKS.openrouter.keysUrl },
  { id: 'mistral', label: 'Mistral', url: PROVIDER_LINKS.mistral.keysUrl },
];
