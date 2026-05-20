//! Per-model token pricing. Static table; not perfectly accurate forever —
//! vendors revise prices, and there's no per-account negotiated pricing
//! awareness — but accurate enough for "did I just spend $5 or $50 this
//! month?" decisions. When the model is unknown the cost lookup returns
//! `None` and the run is recorded with `cost_micros = 0` (UI shows "—").
//!
//! Prices are USD per million tokens, listed (input, output). Matching is
//! by case-insensitive substring against the model id the vendor reported,
//! taking the *first* entry that contains the search key. Most specific
//! entries come first so "gpt-5-mini" doesn't accidentally match "gpt-5".

/// Lookup: returns (input_per_million_usd, output_per_million_usd) for a
/// model id, or None if no entry matches. Designed to be cheap to call on
/// every recorded run.
pub fn lookup(model_id: &str) -> Option<(f64, f64)> {
    let m = model_id.to_ascii_lowercase();
    // Order matters: more-specific keys before more-general ones.
    const TABLE: &[(&str, f64, f64)] = &[
        // OpenAI
        ("gpt-5-mini",         0.15,  0.60),
        ("gpt-5",              2.50, 10.00),
        ("gpt-4.1-mini",       0.15,  0.60),
        ("gpt-4.1",            2.00,  8.00),
        ("gpt-4o-mini",        0.15,  0.60),
        ("gpt-4o",             2.50, 10.00),
        ("o1-mini",            3.00, 12.00),
        ("o1-preview",        15.00, 60.00),
        ("o1",                15.00, 60.00),
        ("gpt-3.5-turbo",      0.50,  1.50),
        // Anthropic
        ("claude-opus-4-7",   15.00, 75.00),
        ("claude-opus-4",     15.00, 75.00),
        ("claude-sonnet-4-6",  3.00, 15.00),
        ("claude-sonnet-4",    3.00, 15.00),
        ("claude-haiku-4-5",   0.80,  4.00),
        ("claude-haiku-4",     0.80,  4.00),
        ("claude-3-5-sonnet",  3.00, 15.00),
        ("claude-3-5-haiku",   0.80,  4.00),
        ("claude-3-opus",     15.00, 75.00),
        // Gemini (via OpenAI-compat endpoint, ids include "gemini-").
        // More-specific keys listed first so "gemini-flash-lite-latest"
        // doesn't get hijacked by the broader "gemini-2.5-flash" match.
        ("gemini-flash-lite", 0.10,  0.40),
        ("gemini-2.5-pro",     1.25,  5.00),
        ("gemini-2.5-flash",   0.15,  0.60),
        ("gemini-2.0-flash",   0.10,  0.40),
        ("gemini-1.5-pro",     1.25,  5.00),
        ("gemini-1.5-flash",   0.075, 0.30),
        // xAI
        ("grok-4",             5.00, 25.00),
        ("grok-3",             3.00, 15.00),
        // Groq (hosted Llama / Mixtral)
        ("llama-3.3-70b",      0.59,  0.79),
        ("llama-3.1-70b",      0.59,  0.79),
        ("llama-3.1-8b",       0.05,  0.08),
        ("mixtral-8x7b",       0.24,  0.24),
        // Together (id format: "meta-llama/Llama-3.3-70B-…")
        ("llama-3.3-70b-instruct", 0.88, 0.88),
        ("llama-3.1-405b",     3.50,  3.50),
        // DeepSeek
        ("deepseek-chat",      0.27,  1.10),
        ("deepseek-reasoner",  0.55,  2.19),
        // Mistral
        ("mistral-large",      2.00,  6.00),
        ("mistral-small",      0.20,  0.60),
        ("codestral",          0.20,  0.60),
        // OpenRouter prefixes the model with the upstream vendor; we match
        // against the suffix above so "openai/gpt-5-mini" still hits.
    ];
    // First exact match by substring wins.
    for (key, in_per_m, out_per_m) in TABLE {
        if m.contains(key) {
            return Some((*in_per_m, *out_per_m));
        }
    }
    None
}

/// Compute cost in micro-dollars (1 USD = 1_000_000 micros) for a given run.
/// Returns 0 when no price is known and token counts are zero — the caller
/// stores 0 to mean "unknown" and the UI renders a placeholder.
///
/// Per-connection override semantics: pass non-zero values in
/// `override_in_per_m` / `override_out_per_m` and they win over the
/// embedded table. A zero override means "fall back to the table." This
/// makes the column default of 0.0 in `provider_connections` behave
/// correctly without bespoke null-handling at every call site.
pub fn cost_micros(
    model_id: &str,
    input_tokens: i64,
    output_tokens: i64,
    override_in_per_m: f64,
    override_out_per_m: f64,
) -> i64 {
    if input_tokens <= 0 && output_tokens <= 0 {
        return 0;
    }
    // Pull the table entry once; the override path may want only one
    // direction (e.g. user sets input price but leaves output to fall
    // back). Independent per-direction fallback keeps that case sane.
    let table = lookup(model_id);
    let in_per_m = if override_in_per_m > 0.0 {
        override_in_per_m
    } else {
        table.map(|(i, _)| i).unwrap_or(0.0)
    };
    let out_per_m = if override_out_per_m > 0.0 {
        override_out_per_m
    } else {
        table.map(|(_, o)| o).unwrap_or(0.0)
    };
    if in_per_m == 0.0 && out_per_m == 0.0 {
        return 0;
    }
    let micros = (input_tokens as f64) * in_per_m + (output_tokens as f64) * out_per_m;
    micros.round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_matches_known_models() {
        assert!(lookup("gpt-5-mini").is_some());
        assert!(lookup("openai/gpt-5-mini").is_some()); // OpenRouter prefix
        assert!(lookup("claude-sonnet-4-6").is_some());
        assert!(lookup("gemini-2.5-flash").is_some());
    }

    #[test]
    fn lookup_returns_none_for_unknown() {
        assert!(lookup("totally-made-up-model").is_none());
        assert!(lookup("llama3.3").is_none()); // local Ollama — no pricing
    }

    #[test]
    fn cost_is_sum_of_input_and_output_priced() {
        // 1M input @ $0.15/M + 1M output @ $0.60/M = $0.75 = 750_000 micros
        let c = cost_micros("gpt-5-mini", 1_000_000, 1_000_000, 0.0, 0.0);
        assert_eq!(c, 750_000);
    }

    #[test]
    fn cost_zero_for_unknown_model() {
        assert_eq!(cost_micros("llama3.3", 1000, 1000, 0.0, 0.0), 0);
    }

    #[test]
    fn cost_zero_for_no_tokens() {
        assert_eq!(cost_micros("gpt-5-mini", 0, 0, 0.0, 0.0), 0);
    }

    #[test]
    fn override_takes_precedence_over_table() {
        // table entry would be $0.15/M + $0.60/M; we pass $1/M / $5/M
        let c = cost_micros("gpt-5-mini", 1_000_000, 1_000_000, 1.0, 5.0);
        assert_eq!(c, 6_000_000); // $6 total
    }

    #[test]
    fn override_falls_back_per_direction() {
        // input override set, output falls back to table ($0.60/M)
        let c = cost_micros("gpt-5-mini", 1_000_000, 1_000_000, 1.0, 0.0);
        assert_eq!(c, 1_000_000 + 600_000); // $1 + $0.60 = $1.60
    }

    #[test]
    fn override_works_for_unknown_model() {
        // even with no table entry, explicit override prices a run
        let c = cost_micros("custom-internal-model", 1_000_000, 500_000, 2.0, 8.0);
        assert_eq!(c, 2_000_000 + 4_000_000); // $2 + $4
    }
}
