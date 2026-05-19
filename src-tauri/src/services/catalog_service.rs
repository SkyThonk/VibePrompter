//! Read-only access to the seeded `prompt_modes` and `providers` catalogs.
//! Lets the frontend's mode/provider lists be backed by real data now; write
//! paths and dedicated services arrive in sub-project 2.

use crate::models::{ProviderInfo, PromptMode};
use crate::storage::repositories::{ModeRepo, ProviderRepo};
use crate::utils::AppResult;

#[derive(Clone)]
pub struct CatalogService {
    modes: ModeRepo,
    providers: ProviderRepo,
}

impl CatalogService {
    pub fn new(modes: ModeRepo, providers: ProviderRepo) -> Self {
        Self { modes, providers }
    }

    /// List all prompt modes.
    pub async fn list_modes(&self) -> AppResult<Vec<PromptMode>> {
        self.modes.list().await
    }

    pub async fn save_mode(&self, mode: PromptMode) -> AppResult<PromptMode> {
        // New rows go to the end; updates keep their existing slot.
        let sort_order = match self.modes.get(&mode.id).await {
            Ok(_) => 0, // ignored by upsert UPDATE branch
            Err(_) => self.modes.max_sort_order().await? + 1,
        };
        self.modes.upsert(&mode, sort_order).await?;
        self.modes.get(&mode.id).await
    }

    pub async fn delete_mode(&self, id: &str) -> AppResult<()> {
        self.modes.delete(id).await
    }

    /// List all providers.
    pub async fn list_providers(&self) -> AppResult<Vec<ProviderInfo>> {
        self.providers.list().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::pool::test_pool;
    use crate::storage::repositories::{ModeRepo, ProviderRepo};

    #[tokio::test]
    async fn lists_seeded_catalog() {
        let pool = test_pool().await;
        let service =
            CatalogService::new(ModeRepo::new(pool.clone()), ProviderRepo::new(pool.clone()));
        assert_eq!(service.list_modes().await.unwrap().len(), 6);
        assert_eq!(service.list_providers().await.unwrap().len(), 4);
    }
}
