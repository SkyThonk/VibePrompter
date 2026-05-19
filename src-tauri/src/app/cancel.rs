//! Per-stream cancellation registry. Each in-flight streaming completion
//! registers a cheap `Arc<AtomicBool>`; the frontend's `cancel_stream`
//! command flips it and the streaming loop bails on the next chunk.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct CancelRegistry {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve a token for a new stream id. Returns the flag the streaming
    /// code should check on every chunk.
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.inner.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }

    /// Mark a stream cancelled. Idempotent — calling on an unknown id is a
    /// no-op, which matches the UX of "cancel a stream that already finished".
    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.inner.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// Forget a stream id when it finishes naturally. Bounded memory.
    pub fn forget(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}
