//! UI Automation text-selection capture.
//!
//! Reads the focused element's active text selection via IUIAutomation without
//! touching the clipboard at all. Returns None when:
//!   - The focused element doesn't expose IUIAutomationTextPattern (games,
//!     custom renderers, some Electron apps).
//!   - UIA COM initialisation fails.
//!   - The selection is empty.
//!
//! Callers must fall back to Ctrl+C when None is returned.

use windows::core::Interface;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};

/// Try to read the current text selection from the focused window using
/// UI Automation. Zero clipboard involvement on success.
pub fn get_selected_text() -> Option<String> {
    // Safety: all unsafe UIA/COM calls are contained within this block.
    // We handle every possible failure by returning None — the caller falls
    // back to clipboard if we return None.
    unsafe { try_get().ok().flatten() }
}

unsafe fn try_get() -> windows::core::Result<Option<String>> {
    // STA is the correct apartment for UIAutomation client processes (MSDN).
    // Returns S_FALSE if the thread is already STA (fine — proceed).
    // Returns RPC_E_CHANGED_MODE if the thread was initialised as MTA — we
    // still proceed since the thread already has a valid COM context and UIA
    // cross-process marshaling works from either apartment.
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

    let automation: IUIAutomation =
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;

    let element = automation.GetFocusedElement()?;

    // GetCurrentPattern returns IUnknown; cast to the text pattern interface.
    // Fails (returns Err) if the element does not support the text pattern —
    // that is the normal "not supported" path, not a bug.
    let text_pattern: IUIAutomationTextPattern =
        element.GetCurrentPattern(UIA_TextPatternId)?.cast()?;

    let ranges = text_pattern.GetSelection()?;
    if ranges.Length()? == 0 {
        return Ok(None);
    }

    // GetText(-1) returns the full text of the range with no length cap.
    let text = ranges.GetElement(0)?.GetText(-1)?.to_string();

    Ok(if text.trim().is_empty() { None } else { Some(text) })
}
