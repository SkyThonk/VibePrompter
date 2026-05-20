//! Minimal placeholder substitution for system prompts.
//!
//! Syntax: `{{var_name}}` — alphanumeric + underscore, no whitespace
//! inside the braces. Anything not matching is passed through unchanged
//! so accidental braces in user prompts (URLs, code, JSON examples) keep
//! working.
//!
//! Values come from the mode's `variables` field (a JSON object string).
//! Missing keys substitute to an empty string — the alternative would be
//! either rejecting the prompt at call time (annoying for partial fills)
//! or leaving the literal `{{var}}` in the prompt (model would echo it).
//! Empty is the least-surprise default.

/// Substitute `{{var}}` placeholders in `prompt` with values from the
/// JSON object `variables_json`. Returns the rendered prompt. Failures
/// (e.g. malformed JSON) leave the prompt unchanged — never strand a
/// user with no system prompt because their variables JSON was broken.
pub fn render(prompt: &str, variables_json: &str) -> String {
    if !prompt.contains("{{") {
        return prompt.to_string();
    }
    let map: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(variables_json)
    {
        Ok(serde_json::Value::Object(m)) => m,
        _ => return prompt.to_string(),
    };

    let mut out = String::with_capacity(prompt.len());
    let bytes = prompt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Look for "{{" followed by ident chars followed by "}}".
        if i + 4 <= bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            // Identifier: ASCII alphanumeric + underscore. Reject leading
            // digit so `{{1}}` isn't treated as a variable (likely a user
            // typo or numeric literal in some example).
            let mut first = true;
            while j < bytes.len() {
                let c = bytes[j];
                let is_valid = if first {
                    c == b'_' || c.is_ascii_alphabetic()
                } else {
                    c == b'_' || c.is_ascii_alphanumeric()
                };
                if !is_valid {
                    break;
                }
                first = false;
                j += 1;
            }
            // Need at least one ident char + closing "}}".
            if j > i + 2 && j + 1 < bytes.len() && bytes[j] == b'}' && bytes[j + 1] == b'}' {
                let name = std::str::from_utf8(&bytes[i + 2..j]).unwrap_or("");
                let value = map
                    .get(name)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                out.push_str(&value);
                i = j + 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Scan `prompt` and return the set of declared variable names (no
/// duplicates, preserved in first-occurrence order). Used by the
/// frontend mode editor — exposed here because the parsing rules need
/// to match `render()` exactly or the UI would show variables that
/// don't actually substitute.
#[allow(dead_code)] // used by upcoming mode-editor variable discovery
pub fn extract_names(prompt: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let bytes = prompt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 4 <= bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            let mut first = true;
            while j < bytes.len() {
                let c = bytes[j];
                let is_valid = if first {
                    c == b'_' || c.is_ascii_alphabetic()
                } else {
                    c == b'_' || c.is_ascii_alphanumeric()
                };
                if !is_valid {
                    break;
                }
                first = false;
                j += 1;
            }
            if j > i + 2 && j + 1 < bytes.len() && bytes[j] == b'}' && bytes[j + 1] == b'}' {
                if let Ok(name) = std::str::from_utf8(&bytes[i + 2..j]) {
                    if !names.iter().any(|n| n == name) {
                        names.push(name.to_string());
                    }
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_known_vars() {
        let out = render("Tone: {{tone}}.", r#"{"tone": "casual"}"#);
        assert_eq!(out, "Tone: casual.");
    }

    #[test]
    fn missing_vars_become_empty() {
        let out = render("Tone: {{tone}}, audience: {{audience}}.", r#"{"tone": "x"}"#);
        assert_eq!(out, "Tone: x, audience: .");
    }

    #[test]
    fn malformed_json_passes_through() {
        let out = render("Hello {{name}}", "not-json");
        assert_eq!(out, "Hello {{name}}");
    }

    #[test]
    fn unmatched_braces_unchanged() {
        let out = render("style = { color: red }", r#"{"x": "y"}"#);
        assert_eq!(out, "style = { color: red }");
    }

    #[test]
    fn extract_names_returns_dedup_first_occurrence_order() {
        let names = extract_names("Use {{tone}} for {{audience}}, again {{tone}}.");
        assert_eq!(names, vec!["tone", "audience"]);
    }

    #[test]
    fn extract_skips_numeric_leading() {
        let names = extract_names("Year {{1year}} ok {{good_var}}");
        assert_eq!(names, vec!["good_var"]);
    }
}
