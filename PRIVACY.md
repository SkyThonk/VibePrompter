# VibePrompter Privacy Policy

**Effective date:** 2026-05-20
**Last updated:** 2026-05-20

VibePrompter is a desktop application that lets you transform selected text
in any window using an LLM (Large Language Model) of your choice. This
policy describes, in plain language, what data the application handles and
where it goes.

The honest summary, before the details: **VibePrompter does not collect,
store, or transmit any personal information about you to us, our servers,
or any third party.** We don't have servers. Every byte of the data the
app touches stays on your computer, with one explicit exception: when you
run a prompt, the text you sent is delivered directly from your computer
to the LLM provider *you* configured, using *your* API key. We are not in
the middle of that connection.

---

## 1. Information we collect — none

VibePrompter does not:

- Create or require an account.
- Collect telemetry, analytics, or usage metrics about you.
- Send crash reports, error logs, or diagnostic data anywhere.
- Track which features you use, which modes you create, or when you run
  the app.
- Phone home, contact a license server, or check for updates against any
  of our servers.

If a future version of VibePrompter ever adds an optional telemetry feature
(it does not today), it would be **off by default**, **clearly labeled**,
and **opt-in** — and this policy would be updated to describe it before
the feature shipped.

## 2. Information VibePrompter stores on your computer

The application stores the following on your local disk so it can do its
job between launches. None of it leaves your computer because of anything
VibePrompter itself does.

| What | Where | Why |
|---|---|---|
| Provider connections (label, vendor, base URL, default model, tags, notes) | Local SQLite database at `%APPDATA%\com.vibeprompter.app\vibeprompter.db` (Windows) or the OS equivalent. | So you don't have to re-enter them on every launch. |
| API keys you save for those providers | Windows Credential Manager (Windows), Keychain (macOS), or libsecret (Linux) — your operating system's keyring, encrypted per-user by the platform. | So keys aren't stored in plaintext on disk. |
| Prompt modes (system prompts, sampling settings, variable defaults) | Local SQLite database. | So your custom modes persist. |
| History of your prompt runs (the text you selected, the model's response, the mode used, timing, token counts, and the locally-computed estimated dollar cost) | Local SQLite database. | So you can review and re-use past runs. Auto-purges per your retention setting (default: 30 days). |
| App settings (theme, hotkeys, etc.) | Local SQLite database. | So your preferences stick. |
| Logs | Plain text files in the same app data folder. | For diagnostics, viewable from About → Recent logs. |

You can see exactly where all of this lives, copy the paths, or open the
folders from **Settings → About → Storage**.

You can wipe all of it at any time:
- Manually delete the data folder shown in the About panel.
- Or use the option offered by the uninstaller, which prompts you to
  remove all locally-stored data and keyring entries when you uninstall
  the app.

## 3. Information that leaves your computer — only to your chosen LLM provider

When you trigger a prompt (via the global hotkey, the refine overlay, or
any other entry point), VibePrompter makes an HTTPS request directly from
your computer to the LLM provider you configured (for example OpenAI,
Anthropic, Google, OpenRouter, your own local Ollama instance, etc.). The
request includes:

- The text you selected (or typed).
- The system prompt + sampling parameters of the active mode.
- Your API key, sent in the Authorization header.
- Standard HTTP metadata (User-Agent, content-type) plus any custom
  headers you've configured on the connection.

That request goes *directly* from your machine to the vendor's endpoint.
**Nothing about it is routed through, observed by, or copied to any
server operated by VibePrompter or its developer.** The vendor's own
privacy policy and terms of service govern what they do with your data
after it arrives. Those documents are linked from each vendor's website
and are entirely outside our control — you should read the policy of the
specific vendor you've configured.

If you've configured a local LLM (Ollama, LM Studio, llama.cpp, vLLM,
etc.) at a `localhost` address, no data leaves your computer at all.

### Cost estimates are computed locally

When VibePrompter shows you "spent this month" or per-run cost, those
numbers are calculated *on your computer* by multiplying the token counts
the vendor reported back to you by a static per-model price table
embedded in the app. No usage data is sent anywhere for billing
calculation. The vendor's own invoice is authoritative for what you
actually owe them.

## 4. Updates

If you obtained VibePrompter through the **Microsoft Store**, updates are
delivered by Microsoft's standard mechanisms. Microsoft's own privacy
policy applies to that delivery. VibePrompter does not perform any
independent update check against its own servers.

If you obtained VibePrompter as a direct download (outside the Store),
the application does not currently include an auto-update mechanism. You
update manually by downloading a new release.

## 5. Third-party services we use

The desktop application itself does not embed any third-party analytics,
advertising, attribution, or tracking SDKs. The only third parties
involved in a normal use of the app are:

- **The LLM vendors you choose.** Their privacy policies apply to the
  prompts you send.
- **Microsoft**, if you installed through the Store. Their privacy
  policy applies to the delivery + update mechanism.
- **Your operating system's keyring** (Windows Credential Manager,
  macOS Keychain, Linux libsecret). Standard OS facilities; data stays
  on your machine.

We do not share, sell, or rent any user data, because we do not collect
any user data to share, sell, or rent.

## 6. Children's privacy

VibePrompter is not directed at children under 13 years of age. We do
not knowingly collect personal information from children. Because the
application collects no personal information from any user, this section
is more of a formality than a description of an active practice.

## 7. Security

API keys are stored using the operating system's native credential store,
which encrypts them per-user. The local SQLite database is not encrypted
at rest by the application — it relies on your operating system's
file-system permissions and full-disk encryption (e.g. BitLocker,
FileVault) for confidentiality. If you store sensitive content in your
prompt history and you are worried about other users of your machine
reading it, enable full-disk encryption at the OS level.

No system is perfectly secure. If you discover a vulnerability, please
report it via the contact channel below rather than disclosing publicly.

## 8. Open source

VibePrompter is open source. You can read every line of code that
processes your data on your machine. If anything in this policy seems
inconsistent with the code, the code is the authoritative source and we
will fix the policy.

## 9. Changes to this policy

We may update this policy when the app's behavior changes — for example,
if a future version adds a new feature that changes what data is stored
locally, or adds an optional telemetry feature. Material changes will
update the "Last updated" date at the top of this document. The
canonical version of this policy lives at the URL you used to find it;
the version embedded inside the app at the time of a given release
reflects that release's behavior.

## 10. Contact

Questions, concerns, or vulnerability reports:

- **Email:** akashjwork@gmail.com
- **GitHub Issues:** open an issue on the project repository (preferred
  for non-sensitive matters so others with the same question can see the
  answer).

---

*This policy is written in plain language because it should be. If any
part of it is unclear, that's a bug — please let us know.*
